# Servidor Chamada Escola

Versão pública e sanitizada do código-fonte. Ela não contém dados de alunos, equipe, histórico, backups, senhas, chaves ou tokens.

## Uso seguro

1. Copie `.env.example` para `.env`.
2. Preencha todas as senhas com valores exclusivos de pelo menos 12 caracteres.
3. Gere uma `SESSION_SECRET` aleatória com pelo menos 32 caracteres.
4. Informe exclusivamente origens HTTPS em `CORS_ORIGINS`.
5. Publique apenas atrás de um proxy HTTPS confiável.

Os dados operacionais devem permanecer fora do Git e nunca devem ser usados como exemplos neste repositório.
