import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
export function Field({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <label className="field">
      <span>{t(name)}</span>
      {children}
    </label>
  );
}
