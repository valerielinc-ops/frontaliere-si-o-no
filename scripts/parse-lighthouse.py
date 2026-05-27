import json, sys

d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "lighthouse-fresh.json"))
audits = d["audits"]

print("=== BEST PRACTICES FAILURES ===")
bp = d["categories"]["best-practices"]
for ref in bp["auditRefs"]:
    a = audits.get(ref["id"], {})
    if a.get("score") is not None and a["score"] < 1:
        print("  %s: score=%s - %s" % (ref["id"], a["score"], a.get("title", "")))

print("")
print("=== PERFORMANCE OPPORTUNITIES ===")
perf = d["categories"]["performance"]
for ref in perf["auditRefs"]:
    a = audits.get(ref["id"], {})
    if a.get("score") is not None and a["score"] < 1 and ref.get("group") in ("load-opportunities", "diagnostics"):
        details = a.get("details", {})
        savings = details.get("overallSavingsMs", "")
        savings_str = " (%sms)" % savings if savings else ""
        print("  %s: score=%.2f - %s%s" % (ref["id"], a["score"], a.get("title", ""), savings_str))

print("")
print("=== UNUSED JS ===")
uj = audits.get("unused-javascript", {})
for item in uj.get("details", {}).get("items", []):
    print("  %s — waste: %dKB" % (item.get("url", "")[:90], item.get("wastedBytes", 0) // 1024))

print("")
print("=== LCP ELEMENT ===")
lcp = audits.get("largest-contentful-paint-element", {})
for item in lcp.get("details", {}).get("items", []):
    for sub in item.get("items", [item]):
        node = sub.get("node", {})
        if node:
            print("  %s" % node.get("snippet", "")[:120])

print("")
print("=== MAIN THREAD WORK ===")
mt = audits.get("mainthread-work-breakdown", {})
for item in mt.get("details", {}).get("items", [])[:8]:
    print("  %s: %.0fms" % (item.get("groupLabel", item.get("group", "")), item.get("duration", 0)))

print("")
print("=== CONSOLE ERRORS (best-practices) ===")
errs = audits.get("errors-in-console", {})
for item in errs.get("details", {}).get("items", []):
    desc = item.get("description", "")[:120]
    print("  %s" % desc)
