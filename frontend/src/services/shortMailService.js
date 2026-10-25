import api from "./api";

// Short Mail (/api/v1/short-mail) — the mail to Purchase for material received
// short against an invoice: a draft .eml Outlook opens ready to send (the app
// sends nothing itself). Separate from the Rejection Mail — its own right and
// To / CC (the store, 25 Oct 2026: "short mail and rejection mail alag alag ho").
export const shortMailService = {
  settings: (config) => api.get("/short-mail/settings", config),
  saveSettings: (payload) => api.put("/short-mail/settings", payload),
  parts: (storeCode, q, config) => api.get("/short-mail/parts", { params: { store_code: storeCode, q }, ...config }),
  // The mail as an unsent .eml, saved for Outlook to open. Silent: the caller
  // shows the server's reason, read back out of the blob it came in.
  downloadDraft: async (payload, filename) => {
    let res;
    try {
      res = await api.post("/short-mail/draft", payload, { responseType: "blob", silent: true });
    } catch (e) {
      const blob = e?.response?.data;
      if (blob instanceof Blob) {
        try {
          e.response.data = JSON.parse(await blob.text());
        } catch {
          // not JSON: the caller falls back to the error's own message
        }
      }
      throw e;
    }
    const url = window.URL.createObjectURL(new Blob([res.data], { type: "message/rfc822" }));
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },
};
