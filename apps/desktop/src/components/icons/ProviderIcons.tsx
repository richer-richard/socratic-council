/**
 * Provider Icons - SVG icons for each AI provider
 * Discord-style circular avatars using provider logo marks (SVG assets)
 */

import type { Provider } from "../../stores/config";
import openaiLogo from "../../assets/providers/openai.svg";
import anthropicLogo from "../../assets/providers/anthropic.svg";
import googleLogo from "../../assets/providers/google.svg";
import deepseekLogo from "../../assets/providers/deepseek.svg";
import kimiLogo from "../../assets/providers/kimi.svg";

interface IconProps {
  className?: string;
  size?: number;
}

function ProviderLogo({
  src,
  alt,
  className = "",
  size = 24,
}: { src: string; alt: string } & IconProps) {
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "rgba(255,255,255,0.12)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // Many SVG logo marks have generous viewBox padding; scale slightly so they read as true avatars.
          transform: "scale(1.12)",
        }}
        draggable={false}
      />
    </div>
  );
}

/** OpenAI */
export function OpenAIIcon({ className = "", size = 24 }: IconProps) {
  return <ProviderLogo src={openaiLogo} alt="OpenAI" className={className} size={size} />;
}

/** Anthropic */
export function AnthropicIcon({ className = "", size = 24 }: IconProps) {
  return (
    <ProviderLogo src={anthropicLogo} alt="Anthropic" className={className} size={size} />
  );
}

/** Google Gemini */
export function GoogleIcon({ className = "", size = 24 }: IconProps) {
  return <ProviderLogo src={googleLogo} alt="Google Gemini" className={className} size={size} />;
}

/** DeepSeek */
export function DeepSeekIcon({ className = "", size = 24 }: IconProps) {
  return <ProviderLogo src={deepseekLogo} alt="DeepSeek" className={className} size={size} />;
}

/** Kimi / Moonshot */
export function KimiIcon({ className = "", size = 24 }: IconProps) {
  return <ProviderLogo src={kimiLogo} alt="Kimi" className={className} size={size} />;
}

/** System icon for system messages */
export function SystemIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="12" fill="#4B5563" />
      <path
        d="M12 8v1m0 6v1m4-4h-1m-6 0H8m5.66 2.66l-.71.71m-3.9-3.9l-.71.71m4.61 0l.71.71m-3.9 3.9l.71.71"
        stroke="#9CA3AF"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2" stroke="#9CA3AF" strokeWidth="1.5" />
    </svg>
  );
}

/** User icon for user messages */
export function UserIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="12" fill="#6366F1" />
      <circle cx="12" cy="9" r="3" fill="#FFFFFF" />
      <path
        d="M6 18c0-3.3 2.7-6 6-6s6 2.7 6 6"
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Get the appropriate icon component for a provider */
export function getProviderIcon(provider: Provider): React.ComponentType<IconProps> {
  switch (provider) {
    case "openai":
      return OpenAIIcon;
    case "anthropic":
      return AnthropicIcon;
    case "google":
      return GoogleIcon;
    case "deepseek":
      return DeepSeekIcon;
    case "kimi":
      return KimiIcon;
    default:
      return SystemIcon;
  }
}

/** Provider icon component that renders the correct icon based on provider */
export function ProviderIcon({ provider, className = "", size = 24 }: { provider: Provider } & IconProps) {
  const IconComponent = getProviderIcon(provider);
  return <IconComponent className={className} size={size} />;
}
