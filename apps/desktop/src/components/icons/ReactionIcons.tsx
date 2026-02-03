import thumbsUp from "../../assets/emoji/thumbs-up.svg";
import heart from "../../assets/emoji/heart.svg";
import laugh from "../../assets/emoji/laugh.svg";
import sparkle from "../../assets/emoji/sparkle.svg";

export type ReactionId = "thumbs_up" | "heart" | "laugh" | "sparkle";

const REACTION_ICON: Record<ReactionId, string> = {
  thumbs_up: thumbsUp,
  heart,
  laugh,
  sparkle,
};

const REACTION_LABEL: Record<ReactionId, string> = {
  thumbs_up: "thumbs up",
  heart: "heart",
  laugh: "laugh",
  sparkle: "sparkle",
};

interface ReactionIconProps {
  type: ReactionId;
  size?: number;
}

export function ReactionIcon({ type, size = 18 }: ReactionIconProps) {
  return (
    <img
      src={REACTION_ICON[type]}
      width={size}
      height={size}
      alt={REACTION_LABEL[type]}
      style={{ display: "block" }}
      loading="lazy"
      decoding="async"
    />
  );
}
