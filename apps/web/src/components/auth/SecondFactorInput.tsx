import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { Input } from "../ui/input";

export function SecondFactorInput({
  value,
  onChange,
  disabled,
  required = false,
  id = "second-factor",
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  id?: string;
}) {
  const locale = useUiLocale();
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {uiText("Authenticator or recovery code", undefined, undefined, locale)}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        autoComplete="one-time-code"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={64}
        required={required}
        disabled={disabled}
        nativeInput
      />
    </div>
  );
}
