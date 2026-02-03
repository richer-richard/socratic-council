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
  tokens?: { input: number; output: number };
  latencyMs?: number;
}

interface BiddingRound {
  scores: Record<string, number>;
  winner: string;
}

type AgentId = "george" | "cathy" | "grace" | "douglas" | "kate" | "system" | "user";

const AGENTS: Record<AgentId, { name: string; role: string; color: string; bgColor: string; borderColor: string; avatar: string }> = {
  george: { name: "George", role: "Logician", color: "text-george", bgColor: "bg-george/10", borderColor: "border-george", avatar: "🔷" },
  cathy: { name: "Cathy", role: "Ethicist", color: "text-cathy", bgColor: "bg-cathy/10", borderColor: "border-cathy", avatar: "💜" },
  grace: { name: "Grace", role: "Futurist", color: "text-grace", bgColor: "bg-grace/10", borderColor: "border-grace", avatar: "🌱" },
  douglas: { name: "Douglas", role: "Skeptic", color: "text-douglas", bgColor: "bg-douglas/10", borderColor: "border-douglas", avatar: "🔶" },
  kate: { name: "Kate", role: "Historian", color: "text-kate", bgColor: "bg-kate/10", borderColor: "border-kate", avatar: "📚" },
  system: { name: "System", role: "", color: "text-gray-400", bgColor: "bg-gray-700/50", borderColor: "border-gray-600", avatar: "⚙️" },
  user: { name: "You", role: "", color: "text-white", bgColor: "bg-primary/20", borderColor: "border-primary", avatar: "👤" },
};

const AGENT_IDS: AgentId[] = ["george", "cathy", "grace", "douglas", "kate"];

export function Chat({ topic, onNavigate }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [maxTurns] = useState(10);
  const [showBidding, setShowBidding] = useState(false);
  const [currentBidding, setCurrentBidding] = useState<BiddingRound | null>(null);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isPaused, setIsPaused] = useState(false);

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
      content: `Discussion Topic: "${topic}"`,
      timestamp: Date.now(),
    };
    setMessages([topicMessage]);

    // Start the simulated council
    startSimulatedDiscussion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);

  // Generate random bidding scores
  const generateBiddingScores = (excludeAgent?: string): BiddingRound => {
    const scores: Record<string, number> = {};
    let maxScore = 0;
    let winner = "";

    for (const agentId of AGENT_IDS) {
      if (agentId === excludeAgent) continue;
      const score = 40 + Math.random() * 60;
      scores[agentId] = score;
      if (score > maxScore) {
        maxScore = score;
        winner = agentId;
      }
    }

    return { scores, winner };
  };

  // Simulated discussion
  const startSimulatedDiscussion = async () => {
    setIsRunning(true);

    // Demo messages showing what the chat would look like
    const demoMessages = [
      {
        agentId: "george",
        content: `An interesting topic indeed. Let me approach this logically. When we discuss "${topic}", we must first establish clear definitions and premises. What exactly do we mean by each key term? Without precise definitions, we risk talking past each other. The structure of our argument matters as much as its content.`,
      },
      {
        agentId: "cathy",
        content: `I appreciate George's call for clarity, but we must also consider the ethical dimensions here. This isn't merely an abstract logical puzzle - it affects real people and communities. What values are at stake? Who benefits and who might be harmed by different positions? Ethics requires us to look beyond pure reasoning.`,
      },
      {
        agentId: "grace",
        content: `Looking at emerging trends and research, I see this topic evolving significantly in the coming years. Current data suggests we're at an inflection point. The decisions we make now will shape outcomes for decades. Let me outline three possible scenarios based on technological trajectories and social patterns.`,
      },
      {
        agentId: "douglas",
        content: `Hold on - before we get too far ahead, I need to question some of the assumptions being made here. What evidence supports these claims? Are we certain the premises hold? I've seen similar arguments fail when subjected to scrutiny. Show me the data, not speculation.`,
      },
      {
        agentId: "kate",
        content: `This reminds me of historical precedents we shouldn't ignore. In the past, similar debates led to unexpected outcomes. For instance, the discussions around emerging technologies in previous eras teach us valuable lessons about unintended consequences and the importance of inclusive deliberation.`,
      },
    ];

    let previousSpeaker = "";

    // Stream each message with delay
    for (let i = 0; i < demoMessages.length; i++) {
      if (isPaused) {
        await new Promise((resolve) => {
          const checkPaused = () => {
            if (!isPaused) {
              resolve(undefined);
            } else {
              setTimeout(checkPaused, 100);
            }
          };
          checkPaused();
        });
      }

      setCurrentTurn(i + 1);

      // Show bidding round
      const bidding = generateBiddingScores(previousSpeaker);
      // Override winner to match demo sequence
      bidding.winner = demoMessages[i].agentId;
      bidding.scores[demoMessages[i].agentId] = Math.max(...Object.values(bidding.scores)) + 5;

      setCurrentBidding(bidding);
      setShowBidding(true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      setShowBidding(false);

      const msg = demoMessages[i];
      setCurrentSpeaker(msg.agentId);
      previousSpeaker = msg.agentId;

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
      const startTime = Date.now();
      for (let j = 0; j < msg.content.length; j++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id
              ? { ...m, content: msg.content.slice(0, j + 1) }
              : m
          )
        );
      }
      const latencyMs = Date.now() - startTime;

      // Mark as done streaming with token info
      const inputTokens = Math.floor(100 + Math.random() * 50);
      const outputTokens = Math.floor(msg.content.length / 4);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === newMessage.id
            ? { ...m, isStreaming: false, tokens: { input: inputTokens, output: outputTokens }, latencyMs }
            : m
        )
      );

      setTotalTokens((prev) => ({
        input: prev.input + inputTokens,
        output: prev.output + outputTokens,
      }));

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

  const handlePauseResume = () => {
    setIsPaused(!isPaused);
  };

  return (
    <div className="flex-1 flex flex-col h-screen">
      {/* Header */}
      <div className="bg-gray-800/50 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => onNavigate("home")}
              className="text-gray-400 hover:text-white transition-colors"
            >
              ← Back
            </button>
            <div className="h-6 w-px bg-gray-700"></div>
            <div>
              <h1 className="text-lg font-semibold text-white flex items-center gap-2">
                🏛️ Socratic Council
              </h1>
              <p className="text-sm text-gray-400 truncate max-w-lg">
                {topic}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Progress indicator */}
            <div className="flex items-center gap-2">
              <div className="text-sm text-gray-400">
                Turn {currentTurn}/{maxTurns}
              </div>
              <div className="w-32 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
                  style={{ width: `${(currentTurn / maxTurns) * 100}%` }}
                />
              </div>
            </div>

            {/* Token counter */}
            <div className="badge badge-info">
              {totalTokens.input + totalTokens.output} tokens
            </div>

            {/* Control buttons */}
            {isRunning && (
              <>
                <button
                  onClick={handlePauseResume}
                  className="bg-yellow-600 hover:bg-yellow-500 text-white px-4 py-2 rounded-lg text-sm
                    transition-colors flex items-center gap-2"
                >
                  {isPaused ? "▶ Resume" : "⏸ Pause"}
                </button>
                <button
                  onClick={handleStop}
                  className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm
                    transition-colors flex items-center gap-2"
                >
                  ⏹ Stop
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {messages.map((message) => {
              const agent = AGENTS[message.agentId as AgentId] ?? AGENTS.system;
              const isAgent = AGENT_IDS.includes(message.agentId as AgentId);

              return (
                <div
                  key={message.id}
                  className={`message-enter ${message.agentId === "user" ? "flex-row-reverse" : ""}`}
                >
                  <div
                    className={`${agent.bgColor} ${agent.borderColor} border rounded-xl p-4
                      ${message.agentId === currentSpeaker && message.isStreaming ? "ring-2 ring-primary/50" : ""}`}
                  >
                    {/* Message header */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl
                        ${agent.borderColor} border-2 ${currentSpeaker === message.agentId ? "pulse-ring" : ""}`}>
                        {agent.avatar}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`font-semibold ${agent.color}`}>{agent.name}</span>
                          {isAgent && (
                            <span className="text-xs text-gray-500">({agent.role})</span>
                          )}
                        </div>
                        {message.tokens && (
                          <div className="text-xs text-gray-500">
                            {message.tokens.input}→{message.tokens.output} tokens • {message.latencyMs}ms
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Message content */}
                    <div className="text-gray-200 leading-relaxed pl-13">
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
        </div>

        {/* Right sidebar - Agent status & Bidding */}
        <div className="w-72 border-l border-gray-700 bg-gray-800/30 p-4 overflow-y-auto">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Council Status
          </h3>

          {/* Agent list */}
          <div className="space-y-2 mb-6">
            {AGENT_IDS.map((agentId) => {
              const agent = AGENTS[agentId];
              const isSpeaking = currentSpeaker === agentId;

              return (
                <div
                  key={agentId}
                  className={`flex items-center gap-3 p-2 rounded-lg transition-all
                    ${isSpeaking ? `${agent.bgColor} ${agent.borderColor} border` : "hover:bg-gray-700/50"}`}
                >
                  <span className={`text-lg ${isSpeaking ? "pulse-ring" : ""}`}>{agent.avatar}</span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${agent.color}`}>
                      {agent.name}
                    </div>
                    <div className="text-xs text-gray-500">{agent.role}</div>
                  </div>
                  {isSpeaking && (
                    <span className="badge badge-success text-xs">Speaking</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Bidding display */}
          {showBidding && currentBidding && (
            <div className="scale-in">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Bidding Round
              </h3>
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-3 space-y-2">
                {Object.entries(currentBidding.scores)
                  .sort((a, b) => b[1] - a[1])
                  .map(([agentId, score]) => {
                    const agent = AGENTS[agentId as AgentId];
                    const isWinner = agentId === currentBidding.winner;
                    const maxScore = Math.max(...Object.values(currentBidding.scores));
                    const barWidth = (score / maxScore) * 100;

                    return (
                      <div key={agentId} className={`${isWinner ? "winner-highlight" : ""}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className={agent.color}>
                            {agent.avatar} {agent.name}
                          </span>
                          <span className="text-gray-400">
                            {score.toFixed(1)}
                            {isWinner && " ★"}
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full bidding-bar rounded-full ${
                              isWinner ? "bg-gradient-to-r from-yellow-500 to-yellow-400" : "bg-gray-500"
                            }`}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Discussion stats */}
          {!isRunning && currentTurn > 0 && (
            <div className="mt-6 scale-in">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Summary
              </h3>
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Total turns</span>
                  <span className="text-white">{currentTurn}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Messages</span>
                  <span className="text-white">{messages.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Total tokens</span>
                  <span className="text-white">{totalTokens.input + totalTokens.output}</span>
                </div>
                <div className="pt-2 border-t border-gray-700">
                  <button
                    onClick={() => onNavigate("home")}
                    className="w-full bg-primary hover:bg-primary/90 text-white py-2 rounded-lg
                      text-sm font-medium transition-colors"
                  >
                    New Discussion
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer - Current speaker indicator */}
      {currentSpeaker && (
        <div className="bg-gray-800/80 border-t border-gray-700 px-6 py-3">
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className={`${AGENTS[currentSpeaker as AgentId]?.color ?? "text-white"}`}>
              {AGENTS[currentSpeaker as AgentId]?.avatar} {AGENTS[currentSpeaker as AgentId]?.name}
            </span>
            <span className="text-gray-400">is speaking...</span>
            <span className="inline-flex ml-2">
              <span className="typing-dot w-1.5 h-1.5 bg-primary rounded-full mx-0.5" />
              <span className="typing-dot w-1.5 h-1.5 bg-primary rounded-full mx-0.5" />
              <span className="typing-dot w-1.5 h-1.5 bg-primary rounded-full mx-0.5" />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
