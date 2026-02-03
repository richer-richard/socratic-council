/**
 * Provider Icons - SVG icons for each AI provider
 * Discord-style circular avatars with official brand colors
 */

import type { Provider } from "../../stores/config";

interface IconProps {
  className?: string;
  size?: number;
}

/** OpenAI - Black hexagon with white logo mark */
export function OpenAIIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="12" fill="#000000" />
      <path
        d="M18.5 10.5c.3-2.1-1.4-4-3.5-4.3-.4-1.6-1.8-2.7-3.5-2.7-1.4 0-2.6.8-3.2 2-.2 0-.5-.1-.7-.1-1.7 0-3.1 1.4-3.1 3.1 0 .4.1.8.2 1.2C3.6 10.4 3 11.5 3 12.8c0 2.1 1.7 3.8 3.8 3.8.4 0 .8-.1 1.2-.2.6 1 1.7 1.6 2.9 1.6 1.4 0 2.6-.8 3.2-2 .2 0 .5.1.7.1 1.7 0 3.1-1.4 3.1-3.1 0-.4-.1-.8-.2-1.2.6-.7.9-1.5.8-2.3z"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 8v8M9 11l3-3 3 3"
        stroke="#FFFFFF"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Anthropic - Coral/orange with stylized A mark */
export function AnthropicIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="12" fill="#D97757" />
      <path
        d="M12 5L6 17h2.5l1-2.5h5l1 2.5H18L12 5zm0 4.5l1.75 4.5h-3.5L12 9.5z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/** Google Gemini - Blue gradient with G/star mark */
export function GoogleIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="geminiGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="25%" stopColor="#EA4335" />
          <stop offset="50%" stopColor="#FBBC05" />
          <stop offset="75%" stopColor="#34A853" />
          <stop offset="100%" stopColor="#4285F4" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill="url(#geminiGradient)" />
      <path
        d="M12 6l1.5 3.5L17 11l-3.5 1.5L12 16l-1.5-3.5L7 11l3.5-1.5L12 6z"
        fill="#FFFFFF"
      />
      <circle cx="12" cy="11" r="1.5" fill="#FFFFFF" />
    </svg>
  );
}

/** DeepSeek - Blue with diamond/spark mark */
export function DeepSeekIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="12" fill="#0066FF" />
      <path
        d="M12 5l2 4.5 4.5 2-4.5 2-2 4.5-2-4.5L5.5 11.5l4.5-2L12 5z"
        fill="#FFFFFF"
      />
      <path
        d="M12 8.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z"
        fill="#0066FF"
      />
    </svg>
  );
}

/** Kimi/Moonshot - Orange gradient with crescent moon */
export function KimiIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="kimiGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF6B35" />
          <stop offset="100%" stopColor="#F7931E" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill="url(#kimiGradient)" />
      <path
        d="M15 7c-3.3 0-6 2.7-6 6s2.7 6 6 6c.8 0 1.5-.2 2.2-.4-1.2 1-2.8 1.4-4.4 1.4-4.1 0-7.8-3.4-7.8-7.5S8.7 5 12.8 5c1.6 0 3.1.5 4.2 1.4-.7-.3-1.3-.4-2-.4z"
        fill="#FFFFFF"
      />
    </svg>
  );
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
