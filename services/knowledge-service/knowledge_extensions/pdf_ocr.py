"""Network-free English OCR, called only inside the isolated parser worker."""
from __future__ import annotations
import math
from .pdf_parser import PdfParseError
from .parser_sandbox import run_bounded

MAX_OCR_PAGES = 20
MAX_OCR_PIXELS = 4_000_000


def tesseract_page(page):
    width, height = page.get_size()
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise PdfParseError('invalid OCR page dimensions')
    scale = min(2.0, math.sqrt(MAX_OCR_PIXELS / (width * height)), 4096 / max(width,height))
    if scale < 0.1:
        raise PdfParseError('OCR page dimensions exceed limits')
    bitmap = page.render(scale=scale,grayscale=True,may_draw_forms=False)
    try:
        if bitmap.width * bitmap.height > MAX_OCR_PIXELS or bitmap.width > 4096 or bitmap.height > 4096:
            raise PdfParseError('OCR raster exceeds limits')
        # Portable GrayMap avoids Pillow/numpy and bounds the raster to 4 MB.
        pixels = bytes(bitmap.buffer)
        raster = b''.join(pixels[y*bitmap.stride:y*bitmap.stride+bitmap.width] for y in range(bitmap.height))
        image = f'P5\n{bitmap.width} {bitmap.height}\n255\n'.encode() + raster
    finally:
        bitmap.close()
    payload = run_bounded(['tesseract','stdin','stdout','-l','eng','--psm','3'],image,20)
    if len(payload) > 100000:
        raise PdfParseError('OCR text exceeds page limit')
    try:
        return payload.decode('utf-8')
    except UnicodeError as exc:
        raise PdfParseError('OCR returned invalid text') from exc
