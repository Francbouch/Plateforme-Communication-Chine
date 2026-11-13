import { api } from "../client";
import { qc } from "../query";
export async function logout() {
  const result = await api<{ logout_url: string }>("access/logout", {});
  qc.clear();
  window.location.assign(
    result.logout_url === "/" ? "/" : "/cdn-cgi/access/logout",
  );
}
