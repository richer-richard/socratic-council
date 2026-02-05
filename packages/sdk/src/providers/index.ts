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
import type { Transport } from "../transport.js";

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
export function createProvider(
  provider: Provider,
  apiKey: string,
  options?: { baseUrl?: string; transport?: Transport }
): BaseProvider {
  switch (provider) {
    case "openai":
      return new OpenAIProvider(apiKey, options);
    case "anthropic":
      return new AnthropicProvider(apiKey, options);
    case "google":
      return new GoogleProvider(apiKey, options);
    case "deepseek":
      return new DeepSeekProvider(apiKey, options);
    case "kimi":
      return new KimiProvider(apiKey, options);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Provider manager for managing multiple provider instances
 */
export class ProviderManager {
  private providers: Map<Provider, BaseProvider> = new Map();
  private transport?: Transport;

  /**
   * Initialize providers from credentials
   */
  constructor(credentials: ProviderCredentials, options?: { transport?: Transport }) {
    this.transport = options?.transport;
    if (credentials.openai?.apiKey) {
      this.providers.set(
        "openai",
        new OpenAIProvider(credentials.openai.apiKey, {
          baseUrl: credentials.openai.baseUrl,
          transport: this.transport,
        })
      );
    }
    if (credentials.anthropic?.apiKey) {
      this.providers.set(
        "anthropic",
        new AnthropicProvider(credentials.anthropic.apiKey, {
          baseUrl: credentials.anthropic.baseUrl,
          transport: this.transport,
        })
      );
    }
    if (credentials.google?.apiKey) {
      this.providers.set(
        "google",
        new GoogleProvider(credentials.google.apiKey, {
          baseUrl: credentials.google.baseUrl,
          transport: this.transport,
        })
      );
    }
    if (credentials.deepseek?.apiKey) {
      this.providers.set(
        "deepseek",
        new DeepSeekProvider(credentials.deepseek.apiKey, {
          baseUrl: credentials.deepseek.baseUrl,
          transport: this.transport,
        })
      );
    }
    if (credentials.kimi?.apiKey) {
      this.providers.set(
        "kimi",
        new KimiProvider(credentials.kimi.apiKey, {
          baseUrl: credentials.kimi.baseUrl,
          transport: this.transport,
        })
      );
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
  setProvider(provider: Provider, apiKey: string, baseUrl?: string, transport?: Transport): void {
    this.providers.set(
      provider,
      createProvider(provider, apiKey, {
        baseUrl,
        transport: transport ?? this.transport,
      })
    );
  }

  /**
   * Remove a provider
   */
  removeProvider(provider: Provider): boolean {
    return this.providers.delete(provider);
  }
}
