import React from "react";
import ReportScreen from "../../components/spare/ReportScreen.jsx";

// The Issuance Report: what left the store, when and to whom — every issue
// counted as it was issued (returns are the Consumption Report's), under the
// department written on it, with the person it was handed to. Its own screen
// since 17 Oct 2026 ("issuance and consumption ki report alag alag chahiye" —
// the store); the layout, filters and downloads are the two reports' shared
// ReportScreen, the views and figures the server's (ConsumptionTableService,
// report=issuance).
export default function IssuanceReport() {
  return <ReportScreen report="issuance" />;
}
