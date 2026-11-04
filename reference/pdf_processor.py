#!/usr/bin/env python3
"""
Focused Gemini OCR CLI for large PDFs.

This version keeps the pipeline intentionally narrow:
1. Open a PDF with PyMuPDF.
2. Extract each selected page as a single-page PDF in memory.
3. OCR pages concurrently with Gemini.
4. Merge the page outputs into a markdown document.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

try:
    import fitz  # PyMuPDF
except ImportError:
    print("PyMuPDF not found. Install with: pip install PyMuPDF", file=sys.stderr)
    raise SystemExit(1)

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("google-genai not found. Install with: pip install google-genai", file=sys.stderr)
    raise SystemExit(1)

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


DEFAULT_MODEL = "gemini-3.5-flash-lite"
DEFAULT_CONCURRENCY = 8
DEFAULT_TIMEOUT_SECONDS = 180
DEFAULT_RETRIES = 3
DEFAULT_PROMPT = """You are a precise OCR engine.

Transcribe this PDF page into clean markdown.

Rules:
- Preserve the visible text faithfully.
- Preserve headings, lists, paragraphs, and reading order.
- Convert tables into standard markdown tables with exactly one header row.
- If a complex table cannot be represented cleanly as one markdown table, split it into multiple titled tables.
- If the page contains important diagrams or visual callouts, describe them briefly in brackets.
- If the page is blank or has no useful text, return [Blank page].
- Return only the page transcription, with no preamble or commentary.
"""

MEDIA_RESOLUTION_MAP = {
    "low": types.MediaResolution.MEDIA_RESOLUTION_LOW,
    "medium": types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    "high": types.MediaResolution.MEDIA_RESOLUTION_HIGH,
}


@dataclass(slots=True)
class PageResult:
    page_number: int
    text: str
    elapsed_seconds: float
    attempts: int
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


class ProgressReporter:
    def __init__(self, total_pages: int, quiet: bool) -> None:
        self.total_pages = total_pages
        self.quiet = quiet
        self.completed_pages = 0
        self._lock = asyncio.Lock()

    async def report(self, result: PageResult) -> None:
        if self.quiet:
            return
        async with self._lock:
            self.completed_pages += 1
            status = "ok" if result.ok else "error"
            print(
                f"[{self.completed_pages}/{self.total_pages}] page {result.page_number} "
                f"{status} in {result.elapsed_seconds:.1f}s (attempt {result.attempts})",
                file=sys.stderr,
            )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="OCR a PDF page-by-page in parallel with Gemini and merge the results into markdown.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python %(prog)s input.pdf
  python %(prog)s input.pdf --output output.md --concurrency 12
  python %(prog)s input.pdf --start-page 10 --end-page 25
  python %(prog)s input.pdf --output - > output.md
""",
    )
    parser.add_argument("input_pdf", type=Path, help="Input PDF file")
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="Output markdown path. Use '-' for stdout. Defaults to <input>.ocr.md",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        help="Gemini API key. Falls back to GEMINI_API_KEY in the environment.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Gemini model to use (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"Maximum number of pages to OCR in parallel (default: {DEFAULT_CONCURRENCY})",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"Per-request timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS})",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=DEFAULT_RETRIES,
        help=f"Retries per page on request failure (default: {DEFAULT_RETRIES})",
    )
    parser.add_argument(
        "--start-page",
        type=int,
        default=1,
        help="1-based first page to OCR (default: 1)",
    )
    parser.add_argument(
        "--end-page",
        type=int,
        help="1-based last page to OCR (default: last page in document)",
    )
    parser.add_argument(
        "--media-resolution",
        choices=sorted(MEDIA_RESOLUTION_MAP),
        default="medium",
        help="Gemini media resolution hint for PDF input (default: medium)",
    )
    parser.add_argument(
        "--prompt-file",
        type=Path,
        help="Optional UTF-8 text file to override the default OCR prompt",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress progress logging on stderr",
    )
    return parser.parse_args(argv)


def load_prompt(prompt_file: Path | None) -> str:
    if prompt_file is None:
        return DEFAULT_PROMPT
    return prompt_file.read_text(encoding="utf-8").strip()


def resolve_api_key(explicit_api_key: str | None) -> str:
    api_key = explicit_api_key or os.environ.get("GEMINI_API_KEY")
    if api_key:
        return api_key
    raise ValueError("Gemini API key required. Set GEMINI_API_KEY or pass --api-key.")


def resolve_output_path(input_pdf: Path, output_arg: str | None) -> Path | None:
    if output_arg == "-":
        return None
    if output_arg:
        return Path(output_arg).expanduser()
    return input_pdf.with_suffix(".ocr.md")


def resolve_page_window(
    page_count: int,
    start_page: int,
    end_page: int | None,
) -> tuple[int, int]:
    if page_count < 1:
        raise ValueError("Input PDF has no pages.")
    if start_page < 1:
        raise ValueError("--start-page must be at least 1.")

    resolved_end_page = end_page if end_page is not None else page_count
    if resolved_end_page < start_page:
        raise ValueError("--end-page must be greater than or equal to --start-page.")
    if resolved_end_page > page_count:
        raise ValueError(f"--end-page cannot exceed the document page count ({page_count}).")

    return start_page, resolved_end_page


def extract_single_page_pdf(document: fitz.Document, zero_based_page_index: int) -> bytes:
    with fitz.open() as single_page_doc:
        single_page_doc.insert_pdf(
            document,
            from_page=zero_based_page_index,
            to_page=zero_based_page_index,
        )
        return single_page_doc.tobytes(garbage=4, deflate=True)


def strip_outer_markdown_fence(text: str) -> str:
    stripped = text.strip()
    match = re.fullmatch(
        r"```(?:markdown|md)?\s*\n?(.*?)\n?```",
        stripped,
        re.DOTALL | re.IGNORECASE,
    )
    if match:
        return match.group(1).strip()
    return stripped


async def ocr_page(
    *,
    client: genai.aio.AsyncClient,
    model: str,
    prompt: str,
    page_number: int,
    page_pdf_bytes: bytes,
    media_resolution: str,
    retries: int,
) -> PageResult:
    part = types.Part.from_bytes(
        data=page_pdf_bytes,
        mime_type="application/pdf",
        media_resolution=MEDIA_RESOLUTION_MAP[media_resolution],
    )
    config = types.GenerateContentConfig(
        temperature=0,
        response_mime_type="text/plain",
    )

    last_error = "unknown error"
    for attempt in range(1, retries + 2):
        started_at = time.perf_counter()
        try:
            response = await client.models.generate_content(
                model=model,
                contents=[part, prompt],
                config=config,
            )
            text = strip_outer_markdown_fence(response.text or "")
            return PageResult(
                page_number=page_number,
                text=text,
                elapsed_seconds=time.perf_counter() - started_at,
                attempts=attempt,
            )
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            elapsed_seconds = time.perf_counter() - started_at
            if attempt > retries:
                return PageResult(
                    page_number=page_number,
                    text="",
                    elapsed_seconds=elapsed_seconds,
                    attempts=attempt,
                    error=last_error,
                )
            await asyncio.sleep(min(2 ** (attempt - 1), 8))

    return PageResult(
        page_number=page_number,
        text="",
        elapsed_seconds=0.0,
        attempts=retries + 1,
        error=last_error,
    )


async def worker(
    *,
    queue: asyncio.Queue[tuple[int, bytes] | None],
    client: genai.aio.AsyncClient,
    model: str,
    prompt: str,
    media_resolution: str,
    retries: int,
    results: dict[int, PageResult],
    progress: ProgressReporter,
) -> None:
    while True:
        item = await queue.get()
        try:
            if item is None:
                return

            page_number, page_pdf_bytes = item
            result = await ocr_page(
                client=client,
                model=model,
                prompt=prompt,
                page_number=page_number,
                page_pdf_bytes=page_pdf_bytes,
                media_resolution=media_resolution,
                retries=retries,
            )
            results[page_number] = result
            await progress.report(result)
        finally:
            queue.task_done()


async def process_pdf(
    *,
    input_pdf: Path,
    api_key: str,
    model: str,
    concurrency: int,
    timeout: int,
    retries: int,
    start_page: int,
    end_page: int | None,
    media_resolution: str,
    prompt: str,
    quiet: bool,
) -> list[PageResult]:
    base_client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(timeout=timeout),
    )
    async_client = base_client.aio

    try:
        with fitz.open(input_pdf) as document:
            first_page, last_page = resolve_page_window(
                page_count=document.page_count,
                start_page=start_page,
                end_page=end_page,
            )
            selected_pages = last_page - first_page + 1
            worker_count = min(concurrency, selected_pages)
            queue: asyncio.Queue[tuple[int, bytes] | None] = asyncio.Queue(
                maxsize=max(worker_count * 2, 1)
            )
            results: dict[int, PageResult] = {}
            progress = ProgressReporter(total_pages=selected_pages, quiet=quiet)
            workers: list[asyncio.Task[None]] = []

            if not quiet:
                print(
                    f"OCRing pages {first_page}-{last_page} of {input_pdf.name} "
                    f"with {model} (concurrency {worker_count})...",
                    file=sys.stderr,
                )

            try:
                workers = [
                    asyncio.create_task(
                        worker(
                            queue=queue,
                            client=async_client,
                            model=model,
                            prompt=prompt,
                            media_resolution=media_resolution,
                            retries=retries,
                            results=results,
                            progress=progress,
                        )
                    )
                    for _ in range(worker_count)
                ]

                for page_number in range(first_page, last_page + 1):
                    page_pdf_bytes = extract_single_page_pdf(document, page_number - 1)
                    await queue.put((page_number, page_pdf_bytes))

                for _ in workers:
                    await queue.put(None)

                await queue.join()
                await asyncio.gather(*workers)
                return [results[page_number] for page_number in range(first_page, last_page + 1)]
            finally:
                for task in workers:
                    if not task.done():
                        task.cancel()
                if workers:
                    await asyncio.gather(*workers, return_exceptions=True)
    finally:
        await async_client.aclose()
        base_client.close()


def build_output_markdown(input_pdf: Path, model: str, results: Sequence[PageResult]) -> str:
    lines = [f"# OCR: {input_pdf.name}\n\n", f"_Model: {model}_\n\n"]
    failed_pages = [result for result in results if not result.ok]

    for result in results:
        lines.append(f"## Page {result.page_number}\n\n")
        if result.ok:
            lines.append(result.text or "[Blank page]")
            lines.append("\n\n")
        else:
            lines.append(f"[OCR failed: {result.error}]\n\n")
        lines.append("---\n\n")

    if failed_pages:
        lines.append("## Errors\n\n")
        for result in failed_pages:
            lines.append(f"- Page {result.page_number}: {result.error}\n")
        lines.append("\n")

    return "".join(lines).rstrip() + "\n"


def write_output(output_path: Path | None, content: str) -> None:
    if output_path is None:
        sys.stdout.write(content)
        return

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")


async def async_main(argv: Sequence[str] | None = None) -> int:
    if load_dotenv is not None:
        load_dotenv()

    args = parse_args(argv)
    args.input_pdf = args.input_pdf.expanduser()

    if args.concurrency < 1:
        print("--concurrency must be at least 1.", file=sys.stderr)
        return 2
    if args.timeout < 1:
        print("--timeout must be at least 1 second.", file=sys.stderr)
        return 2
    if args.retries < 0:
        print("--retries must be zero or greater.", file=sys.stderr)
        return 2
    if not args.input_pdf.exists():
        print(f"Input PDF not found: {args.input_pdf}", file=sys.stderr)
        return 2

    try:
        api_key = resolve_api_key(args.api_key)
        prompt = load_prompt(args.prompt_file)
        output_path = resolve_output_path(args.input_pdf, args.output)
        results = await process_pdf(
            input_pdf=args.input_pdf,
            api_key=api_key,
            model=args.model,
            concurrency=args.concurrency,
            timeout=args.timeout,
            retries=args.retries,
            start_page=args.start_page,
            end_page=args.end_page,
            media_resolution=args.media_resolution,
            prompt=prompt,
            quiet=args.quiet,
        )
    except Exception as exc:
        print(f"Processing failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    content = build_output_markdown(args.input_pdf, args.model, results)
    write_output(output_path, content)

    failed_pages = [result for result in results if not result.ok]
    if not args.quiet:
        print(
            f"Completed {len(results)} pages with {len(failed_pages)} failures.",
            file=sys.stderr,
        )
        if output_path is None:
            print("Wrote OCR markdown to stdout.", file=sys.stderr)
        else:
            print(f"Wrote OCR markdown to {output_path}", file=sys.stderr)

    return 0 if not failed_pages else 2


def main() -> int:
    try:
        return asyncio.run(async_main())
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
