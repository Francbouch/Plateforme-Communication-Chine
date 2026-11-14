import { isDemo } from "../demo";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
export function SessionNotice() {
  const { t } = useTranslation();
  const config = useQuery({
    queryKey: ["email-auth", "config"],
    enabled: !isDemo,
    queryFn: async () => {
      const r = await fetch("/api/auth/config");
      return r.ok
        ? (r.json() as Promise<{ enabled: boolean }>)
        : { enabled: false };
    },
  });
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const show = () => setExpired(true);
    window.addEventListener("forgebridge:session-expired", show);
    return () =>
      window.removeEventListener("forgebridge:session-expired", show);
  }, []);
  if (!expired) return null;
  return (
    <section className="session-notice" role="alert">
      <p>{t("sessionExpired")}</p>
      <a href={config.data?.enabled ? "/login" : "/cdn-cgi/access/logout"}>
        {t("sessionReconnect")}
      </a>
    </section>
  );
}
