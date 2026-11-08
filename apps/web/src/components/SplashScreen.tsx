import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { webAppIconUrl } from "@cafecode/shared/webAppBranding";
import { useWebAppBranding } from "../webAppBranding";
export function SplashScreen() {
  const uiLocale = useUiLocale();
  const branding = useWebAppBranding();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label={uiText("Cafe Code splash screen", undefined, undefined, uiLocale)}
      >
        <img
          key={branding}
          alt={uiText("Cafe Code", undefined, undefined, uiLocale)}
          className="size-16 object-contain"
          src={webAppIconUrl(branding, "touch-180")}
          onError={(event) => {
            const fallback = webAppIconUrl("neutral", "touch-180");
            if (event.currentTarget.getAttribute("src") === fallback)
              event.currentTarget.hidden = true;
            else event.currentTarget.setAttribute("src", fallback);
          }}
        />
      </div>
    </div>
  );
}
