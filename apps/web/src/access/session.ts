import { api } from "../client";
import { qc } from "../query";
export async function logout() {
  await api("access/logout", {});
  qc.clear();
  window.location.assign("/cdn-cgi/access/logout");
}
