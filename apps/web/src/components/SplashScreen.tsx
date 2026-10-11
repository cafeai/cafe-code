import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
export function SplashScreen() {
  const uiLocale = useUiLocale();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label={uiText("Cafe Code splash screen", undefined, undefined, uiLocale)}
      >
        <img
          alt={uiText("Cafe Code", undefined, undefined, uiLocale)}
          className="size-16 object-contain"
          src="/apple-touch-icon.png"
        />
      </div>
    </div>
  );
}
