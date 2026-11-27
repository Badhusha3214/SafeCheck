"""
SafeCheck scoring  -  how raw measurements become Normal / Borderline / Flag.

READ THIS FIRST (for judges)
----------------------------
Every test produces a few raw metrics, e.g. reaction.mean_ms = 412.

1. NORMAL RANGE.  Each metric has a "normal" mean and standard deviation (SD).
   * Until enough volunteers have done Baseline mode, we use defaults from
     config/config.json.
   * Once >= baseline.min_sessions baseline sessions exist, mean and SD are
     computed from those volunteers instead  ->  normal range = mean +/- 2 SD.

2. Z-SCORE IN THE "BAD" DIRECTION.  We measure how many SDs the person is away
   from normal *in the direction that suggests impairment*:
       lower_better  (e.g. reaction time):  z = (value - mean) / sd
       higher_better (e.g. speaking rate):  z = (mean - value) / sd
       two_sided     (either way is bad):   z = |value - mean| / sd
   Being *better* than average gives z <= 0, which is never penalised.

3. METRIC SCORE 0-100  (piecewise linear, easy to explain):
       z <= 0        -> 100
       0 < z <= 2    -> 100 down to 70   (still inside the normal range)
       2 < z <= 4    ->  70 down to 0    (outside the normal range)
       z > 4         ->   0
   So "70" is exactly the edge of the normal range (mean + 2 SD).

4. TEST SCORE = weighted average of that test's metric scores (weights in config).
   A test whose capture quality is poor (e.g. face visible < 60 % of the time)
   is marked "unreliable" and left out of the overall score, instead of
   silently producing a misleading number.

5. OVERALL SCORE = weighted average of the reliable test scores.
       overall >= normal_min (70)       -> Normal
       overall >= borderline_min (50)   -> Borderline
       otherwise                        -> Flag
   Safety rules on top:  one test below flag_test_below (40) caps the result at
   Borderline; two or more such tests -> Flag.  Fewer than min_tests (2) reliable
   tests -> Incomplete (one test alone is not enough evidence for a verdict).

This is a SCREENING aid, not a medical or legal test.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from statistics import mean, stdev
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "config.json"
TESTS = ("reaction", "eyes", "balance", "speech")


def load_config() -> dict:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    # Hosting override: low-RAM servers can pick a smaller whisper model (e.g. "base").
    if os.environ.get("SAFECHECK_WHISPER_MODEL"):
        cfg["app"]["whisper_model"] = os.environ["SAFECHECK_WHISPER_MODEL"]
    return cfg


# --------------------------------------------------------------------------- #
# 1. Normal ranges (defaults, or learned from baseline volunteers)
# --------------------------------------------------------------------------- #
def default_norm(spec: dict, lang: str | None) -> tuple[float, float]:
    """Default mean/sd from config, with an optional per-language override
    (speech metrics differ between English and Malayalam)."""
    override = spec.get("by_lang", {}).get(lang or "", {})
    return override.get("mean", spec["mean"]), override.get("sd", spec["sd"])


def effective_norms(cfg: dict, baseline_sessions: list[dict], lang: str | None = None) -> dict:
    """Return {test: {metric: {mean, sd, low, high, direction, weight, label, unit, source, n}}}.

    baseline_sessions: list of {"lang": str, "metrics": {test: {metric: value}}}
    Speech metrics only learn from baseline sessions recorded in the same language.
    """
    bcfg = cfg["baseline"]
    norms: dict[str, dict] = {}
    for test, metrics in cfg["metrics"].items():
        norms[test] = {}
        for name, spec in metrics.items():
            d_mean, d_sd = default_norm(spec, lang)
            values = [
                s["metrics"][test][name]
                for s in baseline_sessions
                if (s.get("metrics") or {}).get(test)
                and isinstance(s["metrics"][test].get(name), (int, float))
                and (test != "speech" or s.get("lang") == lang)
            ]
            entry = {k: spec.get(k) for k in ("label", "unit", "direction", "weight")}
            if len(values) >= bcfg["min_sessions"]:
                # Learned normal range. SD is floored so that a very consistent
                # volunteer group does not make the test hypersensitive.
                sd = max(stdev(values), d_sd * bcfg["min_sd_fraction"], 1e-6)
                entry.update(mean=mean(values), sd=sd, source="baseline", n=len(values))
            else:
                entry.update(mean=d_mean, sd=d_sd, source="default", n=len(values))
            entry["low"] = entry["mean"] - 2 * entry["sd"]
            entry["high"] = entry["mean"] + 2 * entry["sd"]
            norms[test][name] = entry
    return norms


# --------------------------------------------------------------------------- #
# 2 + 3. One metric -> z-score -> 0..100
# --------------------------------------------------------------------------- #
def bad_direction_z(value: float, norm: dict) -> float:
    """How many SDs the value is away from normal, in the 'impaired' direction."""
    z = (value - norm["mean"]) / norm["sd"]
    if norm["direction"] == "higher_better":
        z = -z
    elif norm["direction"] == "two_sided":
        z = abs(z)
    return z


def z_to_score(z: float) -> float:
    """Piecewise-linear mapping. 70 == edge of the normal range (2 SD)."""
    if z <= 0:
        return 100.0
    if z <= 2:
        return 100.0 - 15.0 * z          # 0 SD -> 100, 2 SD -> 70
    if z <= 4:
        return 70.0 - 35.0 * (z - 2)     # 2 SD -> 70, 4 SD -> 0
    return 0.0


# --------------------------------------------------------------------------- #
# 4 + 5. Whole session
# --------------------------------------------------------------------------- #
def score_session(metrics: dict[str, Any], norms: dict, cfg: dict) -> dict:
    """metrics: {test: {metric: value, ..., "quality": 0..1} | None (skipped)}"""
    sc = cfg["scoring"]
    tests_out: dict[str, dict] = {}

    for test in TESTS:
        raw = metrics.get(test)
        if not raw:
            tests_out[test] = {"status": "skipped", "score": None, "metrics": {}}
            continue

        quality = raw.get("quality", 1.0)
        metric_rows, wsum, total = {}, 0.0, 0.0
        for name, norm in norms.get(test, {}).items():
            value = raw.get(name)
            if not isinstance(value, (int, float)) or math.isnan(value):
                continue
            z = bad_direction_z(value, norm)
            s = z_to_score(z)
            w = norm.get("weight") or 1.0
            total += s * w
            wsum += w
            metric_rows[name] = {
                "value": value, "score": round(s, 1), "z": round(z, 2),
                "in_range": z <= 2, "label": norm["label"], "unit": norm["unit"], "direction": norm["direction"],
                "low": norm["low"], "high": norm["high"], "source": norm["source"],
            }

        if wsum == 0:
            tests_out[test] = {"status": "skipped", "score": None, "metrics": {}}
            continue
        status = "ok" if quality >= sc["min_quality"] else "unreliable"
        tests_out[test] = {
            "status": status, "score": round(total / wsum, 1),
            "quality": round(quality, 2), "metrics": metric_rows,
        }

    # Overall = weighted mean of reliable tests
    reliable = {t: v for t, v in tests_out.items() if v["status"] == "ok"}
    if not reliable:
        return {"tests": tests_out, "overall": None, "result": "Incomplete",
                "reasons": ["No test produced reliable data."]}

    weights = sc["test_weights"]
    overall = sum(v["score"] * weights.get(t, 1) for t, v in reliable.items()) / sum(
        weights.get(t, 1) for t in reliable
    )

    if overall >= sc["normal_min"]:
        result = "Normal"
    elif overall >= sc["borderline_min"]:
        result = "Borderline"
    else:
        result = "Flag"

    # Safety rules: a single very poor test should never be averaged away.
    poor = [t for t, v in reliable.items() if v["score"] < sc["flag_test_below"]]
    reasons = []
    if len(poor) >= 2:
        result = "Flag"
        reasons.append(f"Two or more tests far outside normal range: {', '.join(poor)}.")
    elif len(poor) == 1 and result == "Normal":
        result = "Borderline"
        reasons.append(f"{poor[0].capitalize()} test far outside normal range.")

    # Too little evidence: a verdict from a single test would be overconfident.
    if len(reliable) < sc.get("min_tests", 2):
        result = "Incomplete"
        reasons.insert(0, f"Only {len(reliable)} reliable test(s); at least {sc.get('min_tests', 2)} are needed for a result.")

    for t, v in tests_out.items():
        if v["status"] == "unreliable":
            reasons.append(f"{t.capitalize()} excluded: poor capture quality ({v['quality']:.0%}).")
        out = [m["label"].lower() for m in v["metrics"].values() if not m["in_range"]]
        if out and v["status"] == "ok":
            reasons.append(f"{t.capitalize()}: {', '.join(out)} outside normal range.")

    return {"tests": tests_out, "overall": round(overall, 1), "result": result, "reasons": reasons}
