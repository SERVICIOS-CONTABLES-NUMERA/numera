import re

with open('sil_search_sample.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Let's find matches for pp_ReporteSeguimiento.php and see what is around them
matches = list(re.finditer(r'href=["\']([^"\']*pp_ReporteSeguimiento\.php[^"\']*)["\']', html))
print(f"Total matches: {len(matches)}")

# Let's inspect the first few matches
for i, match in enumerate(matches[:5]):
    start = max(0, match.start() - 200)
    end = min(len(html), match.end() + 200)
    print(f"\n--- Match {i+1} ---")
    print(html[start:end])
