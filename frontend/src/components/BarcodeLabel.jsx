import React, { useMemo } from "react";
import {
  barcodeSvgString, labelDescription, labelLayout, ptToMm, qrSvgString,
} from "../utils/barcodeRender";

// On-screen preview of the physical label: the QR (or the 1D barcode an admin
// picked) carrying only the Part No., plus Part No., short description and
// location as text. It is drawn from the SAME geometry the print document uses
// (utils/barcodeRender labelLayout), scaled from mm to px, so the preview is
// what comes out of the printer — not a look-alike.
export default function BarcodeLabel({
  value, partNo, description, location, config,
  // The label is scaled to fit inside this box, keeping its real proportion.
  maxWidth = 320, maxHeight = 160,
}) {
  const L = labelLayout(config, partNo);
  const code = value || partNo;
  const desc = labelDescription(description, config);
  const showPn = config?.show_part_no !== false;
  const showDs = config?.show_description !== false;

  const svg = useMemo(() => {
    if (!code) return "";
    try {
      return L.qr
        ? qrSvgString(code)
        : barcodeSvgString(code, { barWidth: 2, height: Math.round(L.h * 2.4), format: L.symbology });
    } catch {
      return "";   // an unencodable value just renders blank; print still guards it
    }
  }, [code, L.qr, L.symbology, L.h]);

  const s = Math.min(maxWidth / L.w, maxHeight / L.h);   // px per mm
  const px = (mm) => mm * s;
  const pt = (p) => ptToMm(p) * s;

  return (
    <div
      className="flex flex-none overflow-hidden border border-slate-300 bg-white text-black shadow-sm"
      style={{
        width: px(L.w), height: px(L.h), padding: px(L.pad), gap: px(L.pad),
        flexDirection: L.side ? "row" : "column",
        alignItems: "center", justifyContent: L.side ? "flex-start" : "center",
        fontFamily: "Arial, Helvetica, sans-serif", boxSizing: "border-box",
      }}
      role="img"
      aria-label={`Label preview: ${partNo || ""}`}
    >
      {L.qr ? (
        <div className="flex-none [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
          style={{ width: px(L.codeMm), height: px(L.codeMm) }}
          dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="w-full flex-none [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-[inherit] [&>svg]:w-full"
          style={{ maxHeight: px(L.barMaxMm) }}
          dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <div
        className="flex min-w-0 flex-col justify-center"
        style={L.side
          ? { width: px(L.textW) }
          : { width: "100%", alignItems: "center", textAlign: "center" }}
      >
        {showPn && (
          <>
            <div style={{ fontSize: pt(L.capPt), lineHeight: 1 }}>Part No.:</div>
            <div style={{
              fontSize: pt(L.pnPt), fontWeight: 700, lineHeight: 1.05, letterSpacing: 0.3,
              overflowWrap: "anywhere", marginTop: px(0.4),
            }}>
              {partNo}
            </div>
          </>
        )}
        {showDs && desc && (
          <div style={{
            fontSize: pt(L.dsPt), lineHeight: 1.15, marginTop: px(1.2), overflow: "hidden",
            display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: L.descLines,
            overflowWrap: "anywhere",
          }}>
            {desc}
          </div>
        )}
        {L.showLocation && (
          <div style={{
            fontSize: pt(L.locPt), fontWeight: 700, lineHeight: 1.1, marginTop: px(1.2),
            overflowWrap: "anywhere",
          }}>
            Location: {location || "—"}
          </div>
        )}
      </div>
    </div>
  );
}
