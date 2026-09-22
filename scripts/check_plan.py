#!/usr/bin/env python3
"""Check coverage bookkeeping only; this is not an application test suite."""
import json,pathlib,re,sys
root=pathlib.Path(__file__).resolve().parents[1]
errors=[]
required=['README.md','docs/REBUILD_BLUEPRINT.md','docs/COVERAGE_MATRIX.md','docs/IMPLEMENTATION_BACKLOG.md','docs/TECHNOLOGY_CATALOG.json','docs/DEPENDENCY_DISPOSITION.json','docs/FIRST_VERTICAL_SLICE.md']
for path in required:
    if not (root/path).is_file():errors.append('Missing '+path)
if errors:
    print('\n'.join(errors));sys.exit(1)
catalog=json.loads((root/'docs/TECHNOLOGY_CATALOG.json').read_text())
disposition=json.loads((root/'docs/DEPENDENCY_DISPOSITION.json').read_text())
if isinstance(disposition,dict):disposition=disposition.get('entries',disposition.get('items',[]))
want={(r['kind'],r['name']) for r in catalog}
got={(r.get('kind'),r.get('name')) for r in disposition}
if want!=got:errors.append(f'Disposition keys differ: {len(want-got)} missing, {len(got-want)} extra')
matrix=(root/'docs/COVERAGE_MATRIX.md').read_text()
ids=re.findall(r'^\| ([A-Z]+\d+) \|',matrix,re.M)
if len(ids)!=len(set(ids)):errors.append('Duplicate coverage IDs')
for component in json.loads((root/'docs/COMPONENTS.json').read_text()):
    if not (root/component['path']/'README.md').exists():errors.append('Missing component '+component['path'])
for md in root.rglob('*.md'):
    if any(part in {'node_modules', '.git', 'dist', 'build'} for part in md.relative_to(root).parts):continue
    for link in re.findall(r'\]\(([^)]+)\)',md.read_text()):
        if link.startswith(('http:','https:','#','mailto:','codex:')):continue
        link=link.split('#')[0].strip('<>')
        if not link:continue
        candidate=pathlib.Path(link)
        if not candidate.is_absolute():candidate=md.parent/candidate
        # Historical archive links live outside this standalone Git repository.
        if not candidate.resolve().is_relative_to(root):continue
        if not candidate.exists():errors.append(f'Broken local link in {md.relative_to(root)}: {link}')
if errors:print('\n'.join(errors));sys.exit(1)
print(f'Planning scaffold checks passed: {len(catalog)} catalog/disposition entries, {len(ids)} unique coverage rows, component READMEs and local Markdown links.')
print('This check validates planning files only. Run make verify and make smoke for application checks.')
