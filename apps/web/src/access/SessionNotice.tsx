import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
export function SessionNotice() {
  const { t } = useTranslation();
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
      <a href="/cdn-cgi/access/logout">{t("sessionReconnect")}</a>
    </section>
  );
}
