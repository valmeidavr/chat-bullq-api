/**
 * Modelo padrão para tarefas baratas/background (classificador de intenção,
 * extração de memória, judge, roteamento primário).
 * (nome da constante mantido por compatibilidade de imports)
 */
export const LLM_SIMPLE_MODEL = 'openai/gpt-4o-mini';

/** Modelo padrão para conversas voltadas ao cliente (escalonamento). */
export const LLM_CONVERSATION_MODEL = 'openai/gpt-4o';

/** Base URL padrão (OpenAI). Sobrescreva com LLM_BASE_URL se precisar. */
export const LLM_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
