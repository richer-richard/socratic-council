/**
 * @fileoverview Provider factory and exports
 * Creates the appropriate provider instance based on the provider type
 */

import type { Provider, ProviderCredentials } from "@socratic-council/shared";
import type { BaseProvider } from "./base.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { DeepSeekProvider } from "./deepseek.js";
import { KimiProvider } from "./kimi.js";

// Re-export all providers
export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { GoogleProvider } from "./google.js";
export { DeepSeekProvider } from "./deepseek.js";
export { KimiProvider, type KimiCompletionOptions } from "./kimi.js";
export * from "./base.js";

/**
 * Create a provider instance from a provider type and API key
 */
export function createProvider(provider: Provider, apiKey: string): BaseProvider {
  switch (provider) {
    case "openai":
      return new OpenAIProvider(apiKey);
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "google":
      return new GoogleProvider(apiKey);
    case "deepseek":
      return new DeepSeekProvider(apiKey);
    case "kimi":
      return new KimiProvider(apiKey);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Provider manager for managing multiple provider instances
 */
export class ProviderManager {
  private providers: Map<Provider, BaseProvider> = new Map();

  /**
   * Initialize providers from credentials
   */
  constructor(credentials: ProviderCredentials) {
    if (credentials.openai?.apiKey) {
      this.providers.set("openai", new OpenAIProvider(credentials.openai.apiKey));
    }
    if (credentials.anthropic?.apiKey) {
      this.providers.set("anthropic", new AnthropicProvider(credentials.anthropic.apiKey));
    }
    if (credentials.google?.apiKey) {
      this.providers.set("google", new GoogleProvider(credentials.google.apiKey));
    }
    if (credentials.deepseek?.apiKey) {
      this.providers.set("deepseek", new DeepSeekProvider(credentials.deepseek.apiKey));
    }
    if (credentials.kimi?.apiKey) {
      this.providers.set("kimi", new KimiProvider(credentials.kimi.apiKey));
    }
  }

  /**
   * Get a provider by type
   */
  getProvider(provider: Provider): BaseProvider | undefined {
    return this.providers.get(provider);
  }

  /**
   * Check if a provider is available
   */
  hasProvider(provider: Provider): boolean {
    return this.providers.has(provider);
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): Provider[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Test all provider connections
   */
  async testConnections(): Promise<Record<Provider, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [provider, instance] of this.providers) {
      try {
        results[provider] = await instance.testConnection();
      } catch {
        results[provider] = false;
      }
    }

    return results as Record<Provider, boolean>;
  }

  /**
   * Add or update a provider
   */
  setProvider(provider: Provider, apiKey: string): void {
    this.providers.set(provider, createProvider(provider, apiKey));
  }

  /**
   * Remove a provider
   */
  removeProvider(provider: Provider): boolean {
    return this.providers.delete(provider);
  }
}
