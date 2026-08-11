---
name: webmcp-captcha-solver
description: >
  Solve CAPTCHAs (reCAPTCHA v2 checkbox/audio/image/invisible, hCaptcha, slider,
  Shopee slider, text/OCR, math) through the local `captcha-solve` CLI and
  python package in webmcp-captcha-solver, which drives the WebMCP browser
  gateway with local vision (Ollama qwen2.5vl) and STT (faster-whisper). Use
  when the user asks to solve/pass a captcha, verify a captcha widget, detect
  captcha presence on a page, or run the captcha solver CLI.
---

# WebMCP Captcha Solver

The `captcha-solve` CLI (repo `webmcp-captcha-solver`) solves captchas by
driving a real Chrome profile through the WebMCP gateway — no cloud captcha
services, no API keys. It reuses the gateway you already bootstrap for browser
automation.

## When to use

- The user wants to pass or solve a captcha challenge (reCAPTCHA v2, hCaptcha,
  slider/puzzle, Shopee slider, distorted-text, math captcha).
- The user wants to know whether a page shows a captcha and which kind
  (`--detect`).
- The user wants a captcha solved as part of a larger WebMCP workflow (chain
  the CLI as a shell step, or call the package API from a script).

## Mandatory prerequisites

1. WebMCP gateway up: `webmcp gateway start` (or `webmcp launch --name ... --gateway`).
2. A Chrome profile connected to the gateway. Pass it explicitly:
   `WEBMCP_PROFILE_ID=<profileId>`.
3. The solver venv exists at `$WEBMCP_CAPTCHA_HOME` (default
   `~/.webmcp/captcha-solver` on release installs; on this dev machine:
   `/Users/ttcenter/Desktop/VIBE_CODE/webmcp-captcha-solver`). Every command
   MUST use `<solver-home>/.venv/bin/captcha-solve` (or
   `.venv/bin/python -m captcha_solver.cli`). Do not use a system python or a
   different venv.

## Quick start

```bash
SOLVER_HOME="${WEBMCP_CAPTCHA_HOME:-$HOME/.webmcp/captcha-solver}"
# if the dev-machine checkout is used instead:
SOLVER_HOME="${SOLVER_HOME:-/Users/ttcenter/Desktop/VIBE_CODE/webmcp-captcha-solver}"
cd "$SOLVER_HOME"
# detect captcha kind + sitekey on a page (no solving, works everywhere)
WEBMCP_PROFILE_ID=<profileId> .venv/bin/captcha-solve --detect --url https://example.com/page

# solve reCAPTCHA v2 (test key) with up to 7 attempts
WEBMCP_PROFILE_ID=<profileId> .venv/bin/captcha-solve --demo recaptcha --attempts 7

# solve a text captcha on a page (custom selectors)
WEBMCP_PROFILE_ID=<profileId> .venv/bin/python - <<'PY'
from captcha_solver.gateway import Gateway
from captcha_solver.solvers.text_captcha import TextCaptchaSolver
gw = Gateway("http://localhost:7865/api", "<profileId>")
tab = gw.new_tab("https://example.com/captcha")
s = TextCaptchaSolver(gw, tab, image_selector="img#captcha",
                      input_selector="input[name='code']",
                      submit_selector="button[type=submit]")
s.prepare()
print(s.solve())
PY
```

## What it solves (status)

| Captcha | Strategy | Status |
| --- | --- | --- |
| reCAPTCHA v2 checkbox | CDP frame bridge + token verify | ✅ cross-origin |
| reCAPTCHA v2 audio | in-frame fetch → whisper → CDP insertText | ✅ cross-origin |
| reCAPTCHA v2 image | tile crop → qwen2.5vl → human-in-the-loop fallback | ⚠️ ~30% |
| reCAPTCHA v2 invisible | grecaptcha.execute + bframe | ✅ |
| reCAPTCHA v3 | detector only (risk score — nothing to solve) | ℹ️ |
| hCaptcha checkbox + task | CDP first, OpenCV fallback | ✅ |
| Slider / puzzle | edge matchTemplate + min-jerk drag | ✅ |
| Shopee slider (line + curve) | asset extract → gap detection → min-jerk drag + sin-arc | ✅ line / ⚠️ curve |
| Text / OCR | ddddocr → tesseract | ✅ ~90% |
| Math | OCR + safe parse (never eval) | ✅ |

## Gateway requirements

- The solver needs the gateway to **pass through raw CDP** (`executeCDP` with
  `Runtime.enable`, `Page.createIsolatedWorld`, `Runtime.evaluate`,
  `Input.dispatchMouseEvent`, `Input.insertText`). `webmcp gateway start` with
  a current browser-kit satisfies this; check with
  `webmcp-captcha-solver`'s `Gateway.supports_cdp()`.
- Known gateway limitation (tracked in `docs/BACKLOG.md`): `Page.getFrameTree`
  via the extension's `chrome.debugger` session does not list cross-origin
  OOPIF iframes, so cross-origin captcha frames (google.com/hcaptcha.com
  iframes embedded in third-party pages) cannot be reached yet. Solver code is
  complete and fails loudly; same-origin flows (fixtures, detector, slider,
  text, math) are unaffected.
- `dispatchClick` emits `isTrusted=true` events (verified) — no synthetic-click
  workaround needed.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `WEBMCP_GATEWAY_URL` | `http://localhost:7865/api` | gateway endpoint |
| `WEBMCP_PROFILE_ID` | *(empty)* | Chrome profile id |
| `CAPTCHA_WORKDIR` | `<repo>/workdir` | scratch dir (auto-cleaned) |
| `CAPTCHA_VISION_URL` | `http://localhost:11434` | Ollama base URL |
| `CAPTCHA_VISION_MODEL` | `qwen2.5vl:7b` | vision model tag |
| `CAPTCHA_WHISPER_MODEL` | `small` | faster-whisper size |
| `CAPTCHA_WHISPER_BEAM` | `5` | beam size for audio decode |
| `CAPTCHA_WHISPER_VOTES` | `1` | majority-vote rounds |
| `CAPTCHA_HITL` | `1` | set `0` to disable human-in-the-loop fallback |
| `CAPTCHA_KEEP_ARTIFACTS` | `0` | keep challenge scratch files |
| `CAPTCHA_LOG_LEVEL` | `INFO` | `DEBUG` for full traces |

## Local test fixtures (no internet, deterministic)

The repo ships a fixture server (`tests/fixtures/server.py`) on
`http://localhost:8099` with deterministic pages: recaptcha_v2 / hcaptcha /
slider / shopee_slider / text_captcha / math_captcha. Use them to verify a
solver end-to-end without third-party rate limits:

```bash
SOLVER_HOME="${WEBMCP_CAPTCHA_HOME:-$HOME/.webmcp/captcha-solver}"
cd "$SOLVER_HOME"
.venv/bin/python tests/fixtures/server.py &
WEBMCP_PROFILE_ID=<profileId> .venv/bin/pytest tests/integration -m local -q
```

## Verify

- Unit suite: `.venv/bin/pytest -m unit` (no browser needed).
- Lint gates: `.venv/bin/ruff check captcha_solver examples` and
  `.venv/bin/python -m pyflakes captcha_solver examples` must both be clean.

See `references/captcha-cli.md` for the full CLI reference and troubleshooting.
