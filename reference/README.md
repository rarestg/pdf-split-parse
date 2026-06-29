# Python reference CLI

The original implementation: page-parallel Gemini OCR for large PDFs, kept here
for local use. The actively developed tool is the TypeScript web app at the repo
root; this directory is a faithful snapshot you can still run with `python3`.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # then put your key in GEMINI_API_KEY
```

You need a Google Gemini API key (see https://aistudio.google.com/apikey).

## Usage

```bash
python pdf_processor.py input.pdf
python pdf_processor.py input.pdf --output out.md --concurrency 8
python pdf_processor.py input.pdf --start-page 10 --end-page 25
python pdf_processor.py input.pdf --output - > out.md
```

Other options: `--model`, `--media-resolution`, `--prompt-file`, `--retries`,
`--timeout`, `--quiet`. Run `python pdf_processor.py --help` for the full list.

> The built-in default model name changes over time. If you get a
> "model not found" error, pass a current one with `--model`, e.g.
> `--model gemini-2.5-flash`.

## How it works

1. Open the PDF with PyMuPDF.
2. Extract each page as a single-page PDF in memory.
3. OCR pages concurrently with Gemini (bounded worker pool, retry with backoff).
4. Merge the page outputs into one Markdown document.
