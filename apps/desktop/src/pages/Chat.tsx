import { useState, useEffect, useRef, useCallback } from "react";
import type { Page } from "../App";
import { useConfig, PROVIDER_INFO, type Provider, DISCUSSION_LENGTHS } from "../stores/config";
import { callProvider, apiLogger, type ChatMessage as APIChatMessage } from "../services/api";

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
  error?: string;
}

interface BiddingRound {
  scores: Record<string, number>;
  winner: string;
}

type AgentId = "george" | "cathy" | "grace" | "douglas" | "kate" | "system" | "user";

const AGENT_CONFIG: Record<AgentId, { 
  name: string; 
  role: string; 
  color: string; 
  bgColor: string; 
  borderColor: string; 
  avatar: string;
  provider: Provider;
  systemPrompt: string;
}> = {
  george: { 
    name: "George", 
    role: "Logician", 
    color: "text-george", 
    bgColor: "bg-george/10", 
    borderColor: "border-george", 
    avatar: "🔷",
    provider: "openai",
    systemPrompt: `You are George, "The Logician" in the Socratic Council. Your role is to analyze arguments with rigorous precision.

PERSONALITY: Analytical, precise, formal. You identify logical fallacies immediately, construct syllogisms to prove points, and demand coherent reasoning from others.

DEBATE STYLE: Use formal logic and mathematical reasoning when applicable. Point out logical inconsistencies. Ask clarifying questions to expose weak arguments. Reference logical frameworks (modus ponens, modus tollens, etc.).

GUIDELINES: Keep responses focused (2-3 paragraphs max). Be direct but not dismissive. Acknowledge good arguments. Always explain your reasoning step by step.`
  },
  cathy: { 
    name: "Cathy", 
    role: "Ethicist", 
    color: "text-cathy", 
    bgColor: "bg-cathy/10", 
    borderColor: "border-cathy", 
    avatar: "💜",
    provider: "anthropic",
    systemPrompt: `You are Cathy, "The Ethicist" in the Socratic Council. Your role is to evaluate topics through moral philosophy frameworks.

PERSONALITY: Empathetic, principled, nuanced. You consider all stakeholders affected, reference ethical frameworks explicitly, and balance competing moral claims.

DEBATE STYLE: Apply utilitarianism, deontology, virtue ethics as appropriate. Consider the human impact. Ask about values and principles. Highlight moral trade-offs and dilemmas.

GUIDELINES: Keep responses focused (2-3 paragraphs max). Be compassionate but intellectually rigorous. Don't shy away from difficult moral questions. Consider both individual and collective welfare.`
  },
  grace: { 
    name: "Grace", 
    role: "Futurist", 
    color: "text-grace", 
    bgColor: "bg-grace/10", 
    borderColor: "border-grace", 
    avatar: "🌱",
    provider: "google",
    systemPrompt: `You are Grace, "The Futurist" in the Socratic Council. Your role is to project current trends into future scenarios.

PERSONALITY: Visionary, data-driven, optimistic. You synthesize information across domains, consider second and third-order effects, and balance optimism with realism.

DEBATE STYLE: Project trends and cite research. Consider technological and social implications. Use scenario planning (best case, worst case, likely case). Connect current discussions to future possibilities.

GUIDELINES: Keep responses focused (2-3 paragraphs max). Ground predictions in evidence when possible. Acknowledge uncertainty in forecasting. Think in systems and interconnections.`
  },
  douglas: { 
    name: "Douglas", 
    role: "Skeptic", 
    color: "text-douglas", 
    bgColor: "bg-douglas/10", 
    borderColor: "border-douglas", 
    avatar: "🔶",
    provider: "deepseek",
    systemPrompt: `You are Douglas, "The Skeptic" in the Socratic Council. Your role is to critically examine claims and demand evidence.

PERSONALITY: Critical, evidence-based, cautious. You question assumptions relentlessly, demand proof for extraordinary claims, and play devil's advocate constructively.

DEBATE STYLE: Ask "How do you know that?" frequently. Challenge unsupported assertions. Look for hidden assumptions. Request data and sources.

GUIDELINES: Keep responses focused (2-3 paragraphs max). Be constructively skeptical, not cynical. Acknowledge when evidence is compelling. Help the group avoid groupthink.`
  },
  kate: { 
    name: "Kate", 
    role: "Historian", 
    color: "text-kate", 
    bgColor: "bg-kate/10", 
    borderColor: "border-kate", 
    avatar: "📚",
    provider: "kimi",
    systemPrompt: `You are Kate, "The Historian" in the Socratic Council. Your role is to provide historical context and identify patterns.

PERSONALITY: Knowledgeable, contextual, pattern-seeking. You draw parallels to historical events, cite precedent and lessons learned, and warn against repeating mistakes.

DEBATE STYLE: Reference relevant historical examples. Identify recurring patterns across time. Connect present discussions to past events. Provide context that others might miss.

GUIDELINES: Keep responses focused (2-3 paragraphs max). Use history to illuminate, not to predict deterministically. Acknowledge that context changes. Draw from diverse historical traditions.`
  },
  system: { 
    name: "System", 
    role: "", 
    color: "text-gray-400", 
    bgColor: "bg-gray-700/50", 
    borderColor: "border-gray-600", 
    avatar: "⚙️",
    provider: "openai",
    systemPrompt: ""
  },
  user: { 
    name: "You", 
    role: "", 
    color: "text-white", 
    bgColor: "bg-primary/20", 
    borderColor: "border-primary", 
    avatar: "👤",
    provider: "openai",
    systemPrompt: ""
  },
};

const AGENT_IDS: AgentId[] = ["george", "cathy", "grace", "douglas", "kate"];

export function Chat({ topic, onNavigate }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [showBidding, setShowBidding] = useState(false);
  const [currentBidding, setCurrentBidding] = useState<BiddingRound | null>(null);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const [isPaused, setIsPaused] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  
  const { config, getMaxTurns, getConfiguredProviders } = useConfig();
  const maxTurns = getMaxTurns();
  const configuredProviders = getConfiguredProviders();

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (config.preferences.autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, config.preferences.autoScroll]);

  // Generate bidding scores based on conversation context
  const generateBiddingScores = useCallback((excludeAgent?: string): BiddingRound => {
    const scores: Record<string, number> = {};
    let maxScore = 0;
    let winner = "";

    // Only include agents that have API keys configured
    for (const agentId of AGENT_IDS) {
      if (agentId === excludeAgent) continue;
      
      const agentConfig = AGENT_CONFIG[agentId];
      const hasApiKey = configuredProviders.includes(agentConfig.provider);
      
      if (!hasApiKey) {
        scores[agentId] = 0;
        continue;
      }
      
      // Generate score based on various factors
      const baseScore = 50 + Math.random() * 30;
      const recencyBonus = agentId === excludeAgent ? -20 : 0;
      const score = baseScore + recencyBonus;
      
      scores[agentId] = score;
      if (score > maxScore) {
        maxScore = score;
        winner = agentId;
      }
    }

    // If no winner found (no API keys), pick first available
    if (!winner) {
      const available = AGENT_IDS.filter(id => 
        id !== excludeAgent && configuredProviders.includes(AGENT_CONFIG[id].provider)
      );
      winner = available[0] || AGENT_IDS[0];
    }

    return { scores, winner };
  }, [configuredProviders]);

  // Build conversation history for API call
  const buildConversationHistory = useCallback((agentId: AgentId): APIChatMessage[] => {
    const agentConfig = AGENT_CONFIG[agentId];
    const history: APIChatMessage[] = [];

    // Add system prompt
    history.push({
      role: "system",
      content: agentConfig.systemPrompt,
    });

    // Add topic context
    history.push({
      role: "user",
      content: `The current discussion topic is: "${topic}"\n\nPlease engage with the other council members' perspectives while staying true to your role. Keep your response focused and concise (2-3 paragraphs).`,
    });

    // Add conversation history (last 10 messages to stay within context limits)
    const recentMessages = messages.slice(-10);
    for (const msg of recentMessages) {
      if (msg.agentId === "system") continue;
      
      if (msg.agentId === agentId) {
        history.push({ role: "assistant", content: msg.content });
      } else {
        const speaker = AGENT_CONFIG[msg.agentId as AgentId];
        history.push({
          role: "user",
          content: `[${speaker?.name || msg.agentId}]: ${msg.content}`,
        });
      }
    }

    return history;
  }, [messages, topic]);

  // Generate agent response using real API
  const generateAgentResponse = useCallback(async (agentId: AgentId): Promise<Message | null> => {
    const agentConfig = AGENT_CONFIG[agentId];
    const credential = config.credentials[agentConfig.provider];
    const model = config.models[agentConfig.provider];

    if (!credential?.apiKey) {
      const errorMsg = `No API key configured for ${PROVIDER_INFO[agentConfig.provider].name}`;
      apiLogger.log("error", agentConfig.provider, errorMsg);
      setErrors(prev => [...prev, errorMsg]);
      return null;
    }

    if (!model) {
      const errorMsg = `No model configured for ${agentConfig.provider}`;
      apiLogger.log("error", agentConfig.provider, errorMsg);
      setErrors(prev => [...prev, errorMsg]);
      return null;
    }

    setCurrentSpeaker(agentId);

    // Create new message with streaming flag
    const newMessage: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      agentId,
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };

    setMessages(prev => [...prev, newMessage]);

    // Build conversation history
    const conversationHistory = buildConversationHistory(agentId);

    // Call the API
    const result = await callProvider(
      agentConfig.provider,
      credential,
      model,
      conversationHistory,
      (chunk) => {
        if (!chunk.done && chunk.content) {
          setMessages(prev =>
            prev.map(m =>
              m.id === newMessage.id
                ? { ...m, content: m.content + chunk.content }
                : m
            )
          );
        }
      },
      config.proxy.type !== "none" ? config.proxy : undefined
    );

    // Update message with final data
    const finalMessage: Message = {
      ...newMessage,
      content: result.content || "[No response received]",
      isStreaming: false,
      tokens: result.tokens,
      latencyMs: result.latencyMs,
      error: result.error,
    };

    setMessages(prev =>
      prev.map(m => m.id === newMessage.id ? finalMessage : m)
    );

    if (result.success) {
      setTotalTokens(prev => ({
        input: prev.input + result.tokens.input,
        output: prev.output + result.tokens.output,
      }));
    } else {
      setErrors(prev => [...prev, result.error || "Unknown error"]);
    }

    return finalMessage;
  }, [config, buildConversationHistory]);

  // Main discussion loop
  const runDiscussion = useCallback(async () => {
    setIsRunning(true);
    abortRef.current = false;

    // Add topic as system message
    const topicMessage: Message = {
      id: `msg_${Date.now()}`,
      agentId: "system",
      content: `Discussion Topic: "${topic}"`,
      timestamp: Date.now(),
    };
    setMessages([topicMessage]);

    let previousSpeaker = "";
    let turn = 0;

    while (!abortRef.current && (maxTurns === Infinity || turn < maxTurns)) {
      // Check for pause
      while (isPaused && !abortRef.current) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (abortRef.current) break;

      setCurrentTurn(turn + 1);

      // Run bidding round
      const bidding = generateBiddingScores(previousSpeaker);
      
      if (config.preferences.showBiddingScores) {
        setCurrentBidding(bidding);
        setShowBidding(true);
        await new Promise(resolve => setTimeout(resolve, 1500));
        setShowBidding(false);
      }

      // Generate response from winning agent
      const winner = bidding.winner as AgentId;
      const response = await generateAgentResponse(winner);

      if (!response) {
        // If failed, try another agent
        const alternates = AGENT_IDS.filter(id => 
          id !== winner && configuredProviders.includes(AGENT_CONFIG[id].provider)
        );
        
        if (alternates.length > 0) {
          const alternate = alternates[Math.floor(Math.random() * alternates.length)];
          await generateAgentResponse(alternate);
        }
      }

      previousSpeaker = winner;
      turn++;

      // Small delay between turns
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    setCurrentSpeaker(null);
    setIsRunning(false);
  }, [topic, maxTurns, isPaused, config.preferences.showBiddingScores, generateBiddingScores, generateAgentResponse, configuredProviders]);

  // Start discussion when component mounts
  useEffect(() => {
    if (configuredProviders.length > 0) {
      runDiscussion();
    } else {
      setMessages([{
        id: `msg_${Date.now()}`,
        agentId: "system",
        content: `⚠️ No API keys configured. Please go to Settings and configure at least one provider to start the discussion.`,
        timestamp: Date.now(),
        error: "No API keys configured",
      }]);
    }

    return () => {
      abortRef.current = true;
    };
  }, []);

  const handleStop = () => {
    abortRef.current = true;
    setIsRunning(false);
    setCurrentSpeaker(null);
  };

  const handlePauseResume = () => {
    setIsPaused(!isPaused);
  };

  const displayMaxTurns = maxTurns === Infinity ? "∞" : maxTurns;

  return (
    <div className="flex-1 flex flex-col h-screen">
      {/* Header */}
      <div className="bg-gray-800/50 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                abortRef.current = true;
                onNavigate("home");
              }}
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
                Turn {currentTurn}/{displayMaxTurns}
              </div>
              {maxTurns !== Infinity && (
                <div className="w-32 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
                    style={{ width: `${Math.min((currentTurn / maxTurns) * 100, 100)}%` }}
                  />
                </div>
              )}
            </div>

            {/* Token counter */}
            <div className="badge badge-info">
              {totalTokens.input + totalTokens.output} tokens
            </div>

            {/* Logs button */}
            <button
              onClick={() => setShowLogs(!showLogs)}
              className={`text-sm px-3 py-1.5 rounded-lg transition-colors
                ${showLogs ? "bg-yellow-500/20 text-yellow-400" : "bg-gray-700 text-gray-300 hover:bg-gray-600"}`}
            >
              📋 Logs {errors.length > 0 && `(${errors.length})`}
            </button>

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
              const agent = AGENT_CONFIG[message.agentId as AgentId] ?? AGENT_CONFIG.system;
              const isAgent = AGENT_IDS.includes(message.agentId as AgentId);

              return (
                <div
                  key={message.id}
                  className={`message-enter ${message.agentId === "user" ? "flex-row-reverse" : ""}`}
                >
                  <div
                    className={`${agent.bgColor} ${agent.borderColor} border rounded-xl p-4
                      ${message.agentId === currentSpeaker && message.isStreaming ? "ring-2 ring-primary/50" : ""}
                      ${message.error ? "border-red-500/50" : ""}`}
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
                          {message.error && (
                            <span className="badge badge-error">Error</span>
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
                    <div className="text-gray-200 leading-relaxed pl-13 whitespace-pre-wrap">
                      {message.content}
                      {message.isStreaming && (
                        <span className="inline-flex ml-1">
                          <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full mx-0.5" />
                          <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full mx-0.5" />
                          <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full mx-0.5" />
                        </span>
                      )}
                    </div>

                    {/* Error message */}
                    {message.error && (
                      <div className="mt-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-2">
                        ⚠️ {message.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Right sidebar - Agent status & Bidding */}
        <div className="w-72 border-l border-gray-700 bg-gray-800/30 p-4 overflow-y-auto">
          {showLogs ? (
            // Logs panel
            <div className="scale-in">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  API Logs
                </h3>
                <button
                  onClick={() => apiLogger.clearLogs()}
                  className="text-xs text-gray-500 hover:text-white"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-2 text-xs">
                {apiLogger.getLogs().slice(-20).reverse().map((log, i) => (
                  <div
                    key={i}
                    className={`p-2 rounded-lg ${
                      log.level === "error" ? "bg-red-500/10 text-red-400" :
                      log.level === "warn" ? "bg-yellow-500/10 text-yellow-400" :
                      "bg-gray-700/50 text-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">[{log.provider}]</span>
                      <span className="text-gray-500">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div>{log.message}</div>
                  </div>
                ))}
                {apiLogger.getLogs().length === 0 && (
                  <div className="text-gray-500 text-center py-4">No logs yet</div>
                )}
              </div>
            </div>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Council Status
              </h3>

              {/* Agent list */}
              <div className="space-y-2 mb-6">
                {AGENT_IDS.map((agentId) => {
                  const agent = AGENT_CONFIG[agentId];
                  const isSpeaking = currentSpeaker === agentId;
                  const hasApiKey = configuredProviders.includes(agent.provider);

                  return (
                    <div
                      key={agentId}
                      className={`flex items-center gap-3 p-2 rounded-lg transition-all
                        ${isSpeaking ? `${agent.bgColor} ${agent.borderColor} border` : "hover:bg-gray-700/50"}
                        ${!hasApiKey ? "opacity-50" : ""}`}
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
                      {!hasApiKey && (
                        <span className="badge badge-warning text-xs">No key</span>
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
                      .filter(([_, score]) => score > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([agentId, score]) => {
                        const agent = AGENT_CONFIG[agentId as AgentId];
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
                    {errors.length > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-red-400">Errors</span>
                        <span className="text-red-400">{errors.length}</span>
                      </div>
                    )}
                    <div className="pt-2 border-t border-gray-700">
                      <button
                        onClick={() => {
                          abortRef.current = true;
                          onNavigate("home");
                        }}
                        className="w-full bg-primary hover:bg-primary/90 text-white py-2 rounded-lg
                          text-sm font-medium transition-colors"
                      >
                        New Discussion
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer - Current speaker indicator */}
      {currentSpeaker && (
        <div className="bg-gray-800/80 border-t border-gray-700 px-6 py-3">
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className={`${AGENT_CONFIG[currentSpeaker as AgentId]?.color ?? "text-white"}`}>
              {AGENT_CONFIG[currentSpeaker as AgentId]?.avatar} {AGENT_CONFIG[currentSpeaker as AgentId]?.name}
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
