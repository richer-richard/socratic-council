import { useState } from "react";
import type { Page } from "../App";

interface HomeProps {
  onNavigate: (page: Page, topic?: string) => void;
}

const AGENTS = [
  {
    id: "george",
    name: "George",
    role: "The Logician",
    description: "Formal logic and argument analysis",
    color: "text-george",
    bgColor: "bg-george/10",
    borderColor: "border-george",
    glowClass: "glow-blue",
    provider: "OpenAI GPT-5.2",
    avatar: "🔷",
  },
  {
    id: "cathy",
    name: "Cathy",
    role: "The Ethicist",
    description: "Moral philosophy frameworks",
    color: "text-cathy",
    bgColor: "bg-cathy/10",
    borderColor: "border-cathy",
    glowClass: "glow-purple",
    provider: "Anthropic Claude 4.5",
    avatar: "💜",
  },
  {
    id: "grace",
    name: "Grace",
    role: "The Futurist",
    description: "Trends and future implications",
    color: "text-grace",
    bgColor: "bg-grace/10",
    borderColor: "border-grace",
    glowClass: "glow-green",
    provider: "Google Gemini 3",
    avatar: "🌱",
  },
  {
    id: "douglas",
    name: "Douglas",
    role: "The Skeptic",
    description: "Evidence and critical analysis",
    color: "text-douglas",
    bgColor: "bg-douglas/10",
    borderColor: "border-douglas",
    glowClass: "glow-yellow",
    provider: "DeepSeek Reasoner",
    avatar: "🔶",
  },
  {
    id: "kate",
    name: "Kate",
    role: "The Historian",
    description: "Historical context and precedent",
    color: "text-kate",
    bgColor: "bg-kate/10",
    borderColor: "border-kate",
    glowClass: "glow-cyan",
    provider: "Kimi K2.5",
    avatar: "📚",
  },
];

const SAMPLE_TOPICS = [
  "Should AI systems have legal rights?",
  "Is democracy the best form of government?",
  "Can consciousness be replicated artificially?",
  "Should we colonize Mars?",
];

export function Home({ onNavigate }: HomeProps) {
  const [topic, setTopic] = useState("");
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  const handleStart = () => {
    if (topic.trim()) {
      onNavigate("chat", topic.trim());
    }
  };

  const handleSampleTopic = (sample: string) => {
    setTopic(sample);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-auto">
      {/* Header */}
      <div className="text-center mb-10 scale-in">
        <div className="flex items-center justify-center gap-3 mb-4">
          <span className="text-5xl">🏛️</span>
          <div>
            <h1 className="text-4xl font-bold gradient-text">
              Socratic Council
            </h1>
            <p className="text-sm text-gray-400 tracking-widest uppercase">
              of Five
            </p>
          </div>
          <span className="text-5xl">🏛️</span>
        </div>
        <p className="text-gray-400 text-lg max-w-lg mx-auto">
          Multi-Agent Group Debate with Emergent Orchestration
        </p>
      </div>

      {/* Council Members */}
      <div className="flex flex-wrap justify-center gap-4 mb-10 max-w-4xl">
        {AGENTS.map((agent, index) => (
          <div
            key={agent.id}
            className={`relative ${agent.bgColor} ${agent.borderColor} border rounded-xl p-4 w-48
              card-hover cursor-default
              ${hoveredAgent === agent.id ? agent.glowClass : ""}`}
            style={{ animationDelay: `${index * 0.1}s` }}
            onMouseEnter={() => setHoveredAgent(agent.id)}
            onMouseLeave={() => setHoveredAgent(null)}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">{agent.avatar}</span>
              <div>
                <div className={`font-semibold ${agent.color}`}>{agent.name}</div>
                <div className="text-gray-400 text-xs">{agent.role}</div>
              </div>
            </div>
            <p className="text-gray-500 text-xs mb-2">{agent.description}</p>
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span className="text-gray-500 text-xs">{agent.provider}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Topic Input Section */}
      <div className="w-full max-w-2xl mb-6 scale-in">
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
          <label className="block text-gray-300 font-medium mb-3">
            What should the council discuss?
          </label>
          <div className="relative">
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStart()}
              placeholder="Enter a thought-provoking topic..."
              className="w-full bg-gray-900/80 border border-gray-600 rounded-xl px-5 py-4 text-white text-lg
                placeholder-gray-500 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20
                transition-all duration-200"
            />
            {topic && (
              <button
                onClick={() => setTopic("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          {/* Sample Topics */}
          <div className="mt-4">
            <p className="text-gray-500 text-sm mb-2">Try a sample topic:</p>
            <div className="flex flex-wrap gap-2">
              {SAMPLE_TOPICS.map((sample) => (
                <button
                  key={sample}
                  onClick={() => handleSampleTopic(sample)}
                  className="bg-gray-700/50 hover:bg-gray-700 text-gray-300 hover:text-white
                    text-sm px-3 py-1.5 rounded-lg transition-colors"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-4 scale-in">
        <button
          onClick={handleStart}
          disabled={!topic.trim()}
          className="bg-gradient-to-r from-primary to-secondary hover:opacity-90
            disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed
            text-white font-semibold px-10 py-4 rounded-xl transition-all duration-200
            flex items-center gap-2 text-lg shadow-lg shadow-primary/25"
        >
          <span>🚀</span>
          Start Discussion
        </button>
        <button
          onClick={() => onNavigate("settings")}
          className="bg-gray-700 hover:bg-gray-600 text-white font-semibold px-8 py-4 rounded-xl
            transition-colors flex items-center gap-2"
        >
          <span>⚙️</span>
          Settings
        </button>
      </div>

      {/* Footer Info */}
      <div className="mt-10 text-center text-gray-500 text-sm">
        <p>Agents compete through bidding to determine speaking order</p>
        <p className="mt-1 text-gray-600">
          Powered by OpenAI, Anthropic, Google, DeepSeek, and Kimi
        </p>
      </div>
    </div>
  );
}
