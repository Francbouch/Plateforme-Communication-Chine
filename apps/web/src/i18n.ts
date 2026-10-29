import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import fr from "./locales/fr-CA.json";
import en from "./locales/en.json";
import zh from "./locales/zh-CN.json";
void i18n.use(initReactI18next).init({
  resources: {
    "fr-CA": { translation: fr },
    en: { translation: en },
    "zh-CN": { translation: zh },
  },
  lng: localStorage.getItem("forgebridge.language") ?? "fr-CA",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
  localStorage.setItem("forgebridge.language", language);
});
document.documentElement.lang = i18n.language;
export default i18n;
