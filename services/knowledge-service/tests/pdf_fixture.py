"""Build tiny text-layer PDFs for parser and pipeline acceptance tests."""

from __future__ import annotations


def make_text_pdf(pages: list[list[str]]) -> bytes:
    objects: list[bytes] = []
    page_ids = [3 + index * 3 for index in range(len(pages))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    for index, lines in enumerate(pages):
        page_id = 3 + index * 3
        content_id = page_id + 1
        font_id = page_id + 2
        operations = ["BT /F1 18 Tf 72 740 Td"]
        for line_index, line in enumerate(lines):
            safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            operations.append(f"({safe}) Tj")
            if line_index + 1 < len(lines):
                operations.append("0 -28 Td")
        operations.append("ET")
        stream = " ".join(operations).encode("ascii")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>".encode()
        )
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(output)
