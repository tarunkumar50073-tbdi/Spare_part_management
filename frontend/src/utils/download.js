import api from "../services/api";

export async function downloadFile(path, filename, params) {
  const res = await api.get(path, { responseType: "blob", params });
  const url = window.URL.createObjectURL(new Blob([res.data]));
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
