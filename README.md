# Please Tell Me

**Please Tell Me** is a Chrome extension that reveals text hidden behind superficial PDF redactions—where content is visually obscured but still present in the document.

It is the conceptual inverse of *Don’t Tell Me*.

---

## What This Extension Does

Many PDFs are “redacted” by simply drawing black boxes over text instead of actually removing the underlying content. Please Tell Me helps identify and reveal those cases.

### Core Capabilities

- Upload and analyze a PDF locally in your browser
- Detect redacted sections created using shapes or annotations
- Determine whether underlying text still exists
- Calculate a **Recovery Percentage**
- Render the full PDF in-browser
- Reveal recoverable text on hover
- Clearly label unrecoverable sections

No OCR. No guessing. No server calls.

---

## Key Metrics

For each document, the extension reports:

- **Total redacted sections**
- **Recoverable sections**
- **Unrecoverable sections**
- **Recovery Percentage**


---

## Interaction Model

### Default View
- Redacted regions appear visually intact
- No automatic text disclosure

### Hover Behavior
- **Recoverable text** → displayed in white text on black background
- **Unrecoverable text** → displays “Unable to recover”

---

## Context Menu (Planned / Partial)

Right-click on a redacted section to:

- **Display all text**  
  Shows recovered text everywhere; unrecoverable areas display “Unable to recover”  
  Small regions may use the abbreviation **UtR**

- **Hide all text**  
  Returns to default hover-only behavior

- **Copy this paragraph**  
  Copies recovered text or “Unable to recover” to clipboard

- **Reprint document**  
  Generates a new PDF with all recovered text shown inline  
  - Disabled if Recovery Percentage = 0%
  - Confirmation required if Recovery Percentage ≤ 25%

---

## What This Extension Does *Not* Do

- ❌ No OCR
- ❌ No inference or reconstruction
- ❌ No bypassing true redaction
- ❌ No network uploads or cloud processing

Please Tell Me only reveals text that already exists in the PDF file.

---

## Technical Notes

- Built using **PDF.js**
- Processing occurs entirely in the browser
- Redactions detected via rectangle / annotation heuristics
- Recoverability determined by presence of selectable text beneath redaction bounds

---

## Chrome Extension Assets

### Required Icons

The extension includes PNG icons at the following sizes:

| Size | Purpose |
|----|----|
| 16×16 | Toolbar |
| 32×32 | System |
| 48×48 | Extensions page |
| 128×128 | Chrome Web Store |

Icons are located in the `/icons` directory.

---

## Chrome Web Store Readiness

Before submission:

- Icons included and referenced in `manifest.json`
- Semantic versioning (e.g. `0.1.0`)
- No unnecessary permissions
- No remote data collection
- Privacy policy available (see `PRIVACY.md`)

---

## Intended Users

- Journalists
- Attorneys
- Researchers
- FOIA reviewers
- Anyone evaluating “redacted” public documents

---

## Disclaimer

Please Tell Me does not defeat encryption or proper redaction.  
It only reveals text that remains embedded in the document.

---

## Status

This repository contains a **working demo (v0)** suitable for testing and iteration.  
UI polish, export workflows, and advanced detection heuristics are ongoing.

---

## License

TBD
