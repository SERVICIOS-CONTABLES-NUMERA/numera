import re

with open('sil_detail_sample.html', 'r', encoding='utf-8') as f:
    html_content = f.read()

# Let's find the table that contains "Cámara Origen"
tables = re.findall(r'<table[^>]*>.*?</table>', html_content, re.DOTALL)
for idx, table in enumerate(tables):
    if "Cámara Origen" in table or "C&aacute;mara Origen" in table:
        print(f"Table index: {idx+1}")
        rows = re.findall(r'<tr[^>]*>.*?</tr>', table, re.DOTALL)
        for r_idx, row in enumerate(rows):
            print(f"Row {r_idx+1}: {repr(row)}")
            # print cell texts
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            for c_idx, cell in enumerate(cells):
                print(f"  Cell {c_idx+1}: {repr(cell.strip())}")
