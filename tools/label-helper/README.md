# DX Store label helper

The helper prints QR labels **straight to the label printer** on this PC. There is no print window, no date or link line on the label, and no page size to set in the printer driver. The store asked for this on 5 Nov 2026: "print mtlb sidha print".

## How it works

- The app (Packets & QR Labels → Print) draws each label as a 300 dpi black-and-white picture of the exact label size.
- It sends the pictures to this helper on `http://127.0.0.1:9123`.
- The helper prints them through the printer's Windows driver, telling the driver the label size with the job.
- If the helper is not running, the app falls back to the browser's print window.

The helper only listens on this PC. It only answers the DX Store app's own addresses: the live site, localhost and the plant LAN. All it does is list printers and print.

## Setup on a PC with a label printer

1. Install the printer's Windows driver. For GoDEX, use the GoDEX / Seagull driver.
2. Copy this folder to the PC, for example to `C:\DX_Store\label-helper`.
3. Double-click `start-label-helper.bat`. A small window, "DX Store label helper", opens minimised. Keep it open.
4. To start it with Windows, press Win+R and type `shell:startup`. Put a shortcut to `start-label-helper.bat` in that folder.
5. In the app, open Packets & QR Labels → Print. The dialog should say **Direct print**. Pick the printer once; the app remembers it.

The first time the live site (`https://digi-store.dxtbdi.com`) talks to the helper, Chrome may ask to let the site access apps or devices on this PC. Choose **Allow**.

## Adjusting the label

The print dialog has Left / Right, Up / Down, QR size and Text size buttons. These settings are saved on that PC, one set per label size.

The 25 × 15 mm roll starts at the sample the store passed on 5 Nov 2026:
- QR 8.7 mm;
- 1.5 mm left;
- about 2 mm from the top;
- code at 84 %, about 4.2 pt.

To print darker or lighter, change the printer's own **Darkness** setting in its driver (Printing preferences).

## Checking it

`http://127.0.0.1:9123/status` in a browser on that PC lists the printers the helper sees.
