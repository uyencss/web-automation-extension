# captcha-solve CLI — Reference

Full reference for the `captcha-solve` entry point in
`/Users/ttcenter/Desktop/VIBE_CODE/webmcp-captcha-solver`
(installed into its own `.venv` as an editable package, version 0.2.0).

## Invocation

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/webmcp-captcha-solver
.venv/bin/captcha-solve --help
```

All commands require the WebMCP gateway (`webmcp gateway start`) and a
connected Chrome profile. Pass `WEBMCP_PROFILE_ID` in the environment.

## Flags

| Flag | Meaning |
| --- | --- |
| `--demo recaptcha` | Solve the local/Google reCAPTCHA v2 flow on the active tab |
| `--attempts N` | Max solve attempts (default `MAX_SOLVE_ATTEMPTS` = 3) |
| `--detect` | Detect captcha presence/kind/sitekey on a page |
| `--url <URL>` | With `--detect`: navigate there first, then report |
| `--log-level LEVEL` | Override `CAPTCHA_LOG_LEVEL` (default INFO) |

Example:

```bash
WEBMCP_PROFILE_ID=<profileId> .venv/bin/captcha-solve --detect --url https://example.com
# table: kind | sitekey | solvable_by_this_package | note
```

`--detect` output kinds: `recaptcha_v2`, `recaptcha_v2_invisible`,
`recaptcha_v3` (detector only — a risk score, nothing to solve), `hcaptcha`,
`turnstile` (out of scope), or an empty list when the page has no captcha.

## Python API (for workflows/scripts)

```python
from captcha_solver.gateway import Gateway
from captcha_solver.solvers import ReCaptchaV2Solver, HCaptchaSolver

gw = Gateway("http://localhost:7865/api", "<profileId>")
gw.ping()                      # True when the gateway is reachable
tab = gw.new_tab(url)
s = ReCaptchaV2Solver(gw, tab, strategy="audio_first")
s.prepare()                    # normalize viewport BEFORE detect/solve
s.detect()                     # captcha present?
result = s.solve()             # SolveResult(ok, solver, attempts, message, details)
s.token()                      # response token — ok ⟺ token is not None
gw.close()
```

Available solvers (`captcha_solver.solvers`):
`ReCaptchaV2Solver`, `ReCaptchaInvisibleSolver`, `HCaptchaSolver`,
`TextCaptchaSolver`, `MathCaptchaSolver`, `SliderSolver`,
`ShopeeSliderSolver`; plus `captcha_solver.detectors.detect_all(gw, tab_id)`.

## Solver behavior notes

- **Verification is token-based.** A solve only counts as passed when the host
  page holds a non-empty response token (`g-recaptcha-response` /
  `h-captcha-response` / `window.__captchaToken`). There is no "overlay gone"
  heuristic, so a missed checkbox click is reported as a failure, never a pass.
- **Retry policy:** read-only gateway calls retry 3×; write calls
  (`dispatchClick`, `moveMouse`, `pressKey`, `typeText`, …) never retry —
  re-sending a click toggles a captcha tile off.
- **Mouse:** min-jerk bezier paths, cursor position tracked between clicks
  (no teleport to (0,0)), CDP-input drags for sliders (`isTrusted=true`).
- **Vision fallback:** if Ollama is down and `CAPTCHA_HITL=1`, the image
  challenge writes a question file to `workdir/challenges/<cid>.json` and waits
  for `workdir/answers/<cid>.json` (`{"tiles": [0, 4, 8]}`). If
  `CAPTCHA_HITL=0` it raises `VisionUnavailable` instead of crashing.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ping False` / gateway unreachable | Run `webmcp gateway start`; check `WEBMCP_GATEWAY_URL`. |
| CDP passthrough error on construction | Old gateway build: upgrade browser-kit; `supports_cdp()` probes `Runtime.enable`. |
| Cross-origin reCAPTCHA/hCaptcha iframes unreachable (`checkbox not found`) | Known gateway OOPIF limitation — see `docs/BACKLOG.md` in the solver repo; same-origin flows unaffected. |
| Google throttles after repeated solves | ReCAPTCHA iframe loads get rate-limited; wait ≥60s, use the official test key `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI`. |
| `text captcha image not found` | Pass explicit `image_selector`/`input_selector`/`submit_selector`. |
| OCR below 85% accuracy | `ddddocr` not installed (`.venv/bin/pip install 'ddddocr>=1.4.7'`); tesseract-only environments read worse. |
| `workdir/challenges` accumulates files | Set `CAPTCHA_KEEP_ARTIFACTS=0` (default) — scratch dirs are removed per attempt. |
| Solver stalls on image challenge | Ollama down + HITL waiting on `workdir/answers/`; answer it or set `CAPTCHA_HITL=0`. |

## Test gates

```bash
.venv/bin/pytest -m unit                    # fast, no browser — must stay green
.venv/bin/pytest -m local                   # browser + fixture server :8099
CAPTCHA_LIVE_TESTS=1 .venv/bin/pytest -m live   # manual smoke, flaky by design
.venv/bin/ruff check captcha_solver examples && .venv/bin/python -m pyflakes captcha_solver examples
```
