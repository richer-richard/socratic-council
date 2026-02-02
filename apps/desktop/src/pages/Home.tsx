import { useState } from "react";
import type { Page } from "../App";

interface HomeProps {
  onNavigate: (page: Page, topic?: string) => void;
}

const AGENTS = [
  { id: "george", name: "George", role: "The Logician", color: "text-george", provider: "OpenAI GPT-5.2" },
  { id: "cathy", name: "Cathy", role: "The Ethicist", color: "text-cathy", provider: "Anthropic Claude 4.5" },
  { id: "grace", name: "Grace", role: "The Futurist", color: "text-grace", provider: "Google Gemini 3" },
  { id: "douglas", name: "Douglas", role: "The Skeptic", color: "text-douglas", provider: "DeepSeek V3.2" },
  { id: "kate", name: "Kate", role: "The Historian", color: "text-kate", provider: "Kimi K2.5" },
];

export function Home({ onNavigate }: HomeProps) {
  const [topic, setTopic] = useState("");

  const handleStart = () => {
    if (topic.trim()) {
      onNavigate("chat", topic.trim());
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      {/* Header */}
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-white mb-2">
          🏛️ Socratic Council of Five
        </h1>
        <p className="text-gray-400 text-lg">
          Multi-Agent Group Chat for Deep Philosophical Debate
        </p>
      </div>

      {/* Council Members */}
      <div className="flex flex-wrap justify-center gap-4 mb-12 max-w-3xl">
        {AGENTS.map((agent) => (
          <div
            key={agent.id}
            className="bg-gray-800 rounded-lg p-4 w-44 text-center hover:bg-gray-750 transition-colors"
          >
            <div className={`text-2xl mb-2 ${agent.color}`}>
              {agent.id === "george" && "🔷"}
              {agent.id === "cathy" && "💜"}
              {agent.id === "grace" && "🌱"}
              {agent.id === "douglas" && "🔶"}
              {agent.id === "kate" && "📚"}
            </div>
            <div className={`font-semibold ${agent.color}`}>{agent.name}</div>
            <div className="text-gray-400 text-sm">{agent.role}</div>
            <div className="text-gray-500 text-xs mt-1">{agent.provider}</div>
          </div>
        ))}
      </div>

      {/* Topic Input */}
      <div className="w-full max-w-xl mb-8">
        <label className="block text-gray-400 text-sm mb-2">
          Enter a topic for the council to discuss:
        </label>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleStart()}
          placeholder="e.g., Should AI have rights?"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Action Buttons */}
      <div className="flex gap-4">
        <button
          onClick={handleStart}
          disabled={!topic.trim()}
          className="bg-primary hover:bg-primary/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold px-8 py-3 rounded-lg transition-colors"
        >
          🚀 Start Discussion
        </button>
        <button
          onClick={() => onNavigate("settings")}
          className="bg-gray-700 hover:bg-gray-600 text-white font-semibold px-8 py-3 rounded-lg transition-colors"
        >
          ⚙️ Settings
        </button>
      </div>
    </div>
  );
}
