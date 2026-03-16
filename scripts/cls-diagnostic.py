import json, sys

f = sys.argv[1] if len(sys.argv) > 1 else "lighthouse-fresh.json"
d = json.load(open(f))
a = d["audits"]

print("=== CLS DETAILS ===")
cls = a.get("cumulative-layout-shift", {})
print(f"CLS Score: {cls.get('numericValue', 'N/A')}")
print(f"Display: {cls.get('displayValue', 'N/A')}")
if "details" in cls:
    for item in cls["details"].get("items", []):
        print(f"  Shift: {json.dumps(item, indent=2)}")

print("\n=== LAYOUT SHIFT ELEMENTS ===")
lse = a.get("layout-shift-elements", {})
if "details" in lse:
    for item in lse["details"].get("items", []):
        print(f"  Score: {item.get('score', 'N/A')}")
        node = item.get("node", {})
        print(f"  Selector: {node.get('selector', 'N/A')}")
        print(f"  Snippet: {node.get('snippet', 'N/A')}")
        print(f"  Path: {node.get('nodeLabel', 'N/A')}")
        print(f"  BoundingRect: {node.get('boundingRect', 'N/A')}")
        print()

print("\n=== LARGEST CONTENTFUL PAINT ELEMENT ===")
lcp = a.get("largest-contentful-paint-element", {})
if "details" in lcp:
    for item in lcp["details"].get("items", []):
        for k, v in item.items():
            if isinstance(v, dict) and "selector" in v:
                print(f"  Selector: {v.get('selector', 'N/A')}")
                print(f"  Snippet: {v.get('snippet', 'N/A')}")
                print(f"  NodeLabel: {v.get('nodeLabel', 'N/A')}")
            else:
                print(f"  {k}: {v}")

print("\n=== RENDER BLOCKING RESOURCES ===")
rb = a.get("render-blocking-resources", {})
print(f"Score: {rb.get('score', 'N/A')}")
print(f"Savings: {rb.get('displayValue', 'N/A')}")
if "details" in rb:
    for item in rb["details"].get("items", []):
        print(f"  URL: {item.get('url', 'N/A')}")
        print(f"  Total: {item.get('totalBytes', 0)/1024:.1f}KB, Wasted: {item.get('wastedMs', 0)}ms")

print("\n=== UNSIZED IMAGES ===")
ui = a.get("unsized-images", {})
print(f"Score: {ui.get('score', 'N/A')}")
if "details" in ui:
    for item in ui["details"].get("items", []):
        node = item.get("node", {})
        print(f"  Selector: {node.get('selector', 'N/A')}")
        print(f"  Snippet: {node.get('snippet', 'N/A')}")

print("\n=== NON-COMPOSITED ANIMATIONS ===")
nca = a.get("non-composited-animations", {})
print(f"Score: {nca.get('score', 'N/A')}")
if "details" in nca:
    for item in nca["details"].get("items", []):
        node = item.get("node", {})
        print(f"  Selector: {node.get('selector', 'N/A')}")
        print(f"  Snippet: {node.get('snippet', 'N/A')}")
        print(f"  Reason: {item.get('subItems', {}).get('items', [])}")

print("\n=== PERFORMANCE OPPORTUNITIES ===")
perf = d["categories"]["performance"]
for ref in perf.get("auditRefs", []):
    audit = a.get(ref["id"], {})
    if audit.get("score") is not None and audit["score"] < 1 and ref.get("weight", 0) > 0:
        print(f"  [{audit['score']:.2f}] {ref['id']} (weight={ref.get('weight',0)}): {audit.get('displayValue', '')}")

print("\n=== DIAGNOSTICS ===")
for key in ["dom-size", "total-byte-weight", "mainthread-work-breakdown", "font-display"]:
    audit = a.get(key, {})
    if audit:
        print(f"  {key}: score={audit.get('score','N/A')}, {audit.get('displayValue','')}")
