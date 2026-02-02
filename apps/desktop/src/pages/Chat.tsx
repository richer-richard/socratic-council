import { useState, useEffect, useRef } from "react";
import type { Page } from "../App";

interface ChatProps {
  topic: string;
  onNavigate: (page: Page) => void;
}

interface Message {
  id: string;
  agentId: string;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

const AGENTS: Record<string, { name: string; color: string; avatar: string }> = {
  george: { name: "George", color: "text-george border-george", avatar: "🔷" },
  cathy: { name: "Cathy", color: "text-cathy border-cathy", avatar: "💜" },
  grace: { name: "Grace", color: "text-grace border-grace", avatar: "🌱" },
  douglas: { name: "Douglas", color: "text-douglas border-douglas", avatar: "🔶" },
  kate: { name: "Kate", color: "text-kate border-kate", avatar: "📚" },
  system: { name: "System", color: "text-gray-400 border-gray-600", avatar: "⚙️" },
  user: { name: "You", color: "text-white border-white", avatar: "👤" },
};

export function Chat({ topic, onNavigate }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Start the discussion when component mounts
  useEffect(() => {
    // Add topic as system message
    const topicMessage: Message = {
      id: `msg_${Date.now()}`,
      agentId: "system",
      content: `Discussion Topic: ${topic}`,
      timestamp: Date.now(),
    };
    setMessages([topicMessage]);

    // Simulate starting the council (in real app, would use @socratic-council/core)
    startSimulatedDiscussion();
  }, [topic]);

  // Simulated discussion (placeholder - real implementation would use Council class)
  const startSimulatedDiscussion = async () => {
    setIsRunning(true);

    // Demo messages showing what the chat would look like
    const demoMessages = [
      {
        agentId: "george",
        content: `An interesting topic indeed. Let me approach this logically. When we discuss "${topic}", we must first establish clear definitions and premises. What exactly do we mean by each key term? Without precise definitions, we risk talking past each other.`,
      },
      {
        agentId: "cathy",
        content: `I appreciate George's call for clarity, but we must also consider the ethical dimensions here. This isn't merely an abstract logical puzzle - it affects real people and communities. What values are at stake? Who benefits and who might be harmed by different positions?`,
      },
      {
        agentId: "grace",
        content: `Looking at emerging trends and research, I see this topic evolving significantly in the coming years. Current data suggests we're at an inflection point. The decisions we make now will shape outcomes for decades. Let me outline three possible scenarios...`,
      },
      {
        agentId: "douglas",
        content: `Hold on - before we get too far ahead, I need to question some of the assumptions being made here. What evidence supports these claims? Are we certain the premises hold? I've seen similar arguments fail when subjected to scrutiny. Show me the data.`,
      },
      {
        agentId: "kate",
        content: `This reminds me of historical precedents we shouldn't ignore. In the past, similar debates led to unexpected outcomes. For instance, the discussions around emerging technologies in previous eras teach us valuable lessons about unintended consequences and the importance of inclusive deliberation.`,
      },
    ];

    // Stream each message with delay
    for (const msg of demoMessages) {
      setCurrentSpeaker(msg.agentId);

      // Add message with streaming flag
      const newMessage: Message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        agentId: msg.agentId,
        content: "",
        timestamp: Date.now(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, newMessage]);

      // Simulate streaming by adding characters gradually
      for (let i = 0; i < msg.content.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id
              ? { ...m, content: msg.content.slice(0, i + 1) }
              : m
          )
        );
      }

      // Mark as done streaming
      setMessages((prev) =>
        prev.map((m) =>
          m.id === newMessage.id ? { ...m, isStreaming: false } : m
        )
      );

      // Pause between messages
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    setCurrentSpeaker(null);
    setIsRunning(false);
  };

  const handleStop = () => {
    setIsRunning(false);
    setCurrentSpeaker(null);
  };

  return (
    <div className="flex-1 flex flex-col h-screen">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => onNavigate("home")}
              className="text-gray-400 hover:text-white"
            >
              ← Back
            </button>
            <div>
              <h1 className="text-lg font-semibold text-white">
                Socratic Council
              </h1>
              <p className="text-sm text-gray-400 truncate max-w-md">
                {topic}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {isRunning && (
              <button
                onClick={handleStop}
                className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded text-sm"
              >
                Stop Discussion
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message) => {
          const agent = AGENTS[message.agentId] ?? AGENTS.system;
          return (
            <div
              key={message.id}
              className={`flex gap-3 message-enter ${
                message.agentId === "user" ? "flex-row-reverse" : ""
              }`}
            >
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-xl border-2 ${agent.color}`}
              >
                {agent.avatar}
              </div>
              <div
                className={`flex-1 max-w-3xl ${
                  message.agentId === "user" ? "text-right" : ""
                }`}
              >
                <div className={`font-medium text-sm mb-1 ${agent.color.split(" ")[0]}`}>
                  {agent.name}
                </div>
                <div
                  className={`bg-gray-800 rounded-lg px-4 py-3 inline-block text-left ${
                    message.agentId === "user"
                      ? "bg-primary text-white"
                      : "text-gray-200"
                  }`}
                >
                  {message.content}
                  {message.isStreaming && (
                    <span className="inline-flex ml-1">
                      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full mx-0.5" />
                      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full mx-0.5" />
                      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full mx-0.5" />
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Footer - Current speaker indicator */}
      {currentSpeaker && (
        <div className="bg-gray-800 border-t border-gray-700 px-6 py-3">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span>{AGENTS[currentSpeaker]?.avatar}</span>
            <span>{AGENTS[currentSpeaker]?.name} is speaking...</span>
          </div>
        </div>
      )}
    </div>
  );
}
