# Deploy em VPS com GitHub, No-IP e Docker

## 1. Abrir o repositorio no computador

No Windows, abra o PowerShell e entre na pasta:

```powershell
cd C:\Users\igorc\Downloads\SERVIDOR
```

Para abrir a pasta no Explorador:

```powershell
explorer .
```

Se tiver VS Code instalado:

```powershell
code .
```

Para conferir se esta conectado ao GitHub:

```powershell
git remote -v
git status
```

Se ainda nao for um repositorio Git:

```powershell
git init
git add .
git commit -m "Versao segura para VPS"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

## 2. O que pedir/usar na Raphtech ou qualquer VPS

Eu nao consegui confirmar uma documentacao oficial publica da Raphtech pelo nome. O que voce precisa no painel da VPS e:

- VPS Ubuntu 22.04 ou 24.04.
- Acesso SSH como `root` ou usuario com `sudo`.
- IP publico da VPS.
- Portas liberadas: `22` para SSH, `80` e `443` para site.
- Docker e Docker Compose instalados.

Evite publicar a porta `3000` diretamente na internet. O `docker-compose.yml` agora prende o app em `127.0.0.1:3000`; quem fica publico e o proxy HTTPS.

## 3. Preparar a VPS

Na VPS:

```bash
sudo apt update
sudo apt install -y git ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Saia e entre no SSH novamente. Depois:

```bash
git clone https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git infancia-feliz
cd infancia-feliz
cp .env.example .env
nano .env
```

No `.env`, ajuste:

```env
ADMIN_USER=admin
ADMIN_PASSWORD=
TABLET_USER=tablet
TABLET_PASSWORD=
COLLAB_USER=colaborador
COLLAB_PASSWORD=
SESSION_SECRET=
SESSION_TTL_MS=2592000000
CORS_ORIGINS=https://seu-dominio.ddns.net
```

Use senhas diferentes para admin, tablets e colaborador. No navegador, o servidor
vai pedir a autenticacao HTTP primeiro:

- Secretaria/admin: use `ADMIN_USER` e `ADMIN_PASSWORD`.
- Tablets das salas: use `TABLET_USER` e `TABLET_PASSWORD`; depois escolha a sala na tela do sistema.
- Colaborador: use `COLLAB_USER` e `COLLAB_PASSWORD`.

Suba o app:

```bash
docker compose up -d --build
docker compose logs -f
```

## 4. No-IP

Se a VPS tiver IP fixo, o caminho mais simples e criar no No-IP um hostname apontando para o IP publico da VPS. Use registro `A` para IPv4 e `AAAA` para IPv6, se existir.

O cliente DUC do No-IP so e necessario quando o IP muda, por exemplo internet residencial. Em VPS geralmente nao precisa, porque o IP publico costuma ser fixo.

## 5. HTTPS com Caddy

Instale o Caddy na VPS e crie um arquivo `/etc/caddy/Caddyfile`:

```caddy
seu-dominio.ddns.net {
  reverse_proxy 127.0.0.1:3000
}
```

Recarregue:

```bash
sudo systemctl reload caddy
```

Depois acesse:

```text
https://seu-dominio.ddns.net
```

## 6. Atualizar depois pelo GitHub

Na VPS:

```bash
cd infancia-feliz
git pull
docker compose up -d --build
```

## 7. Backup

O banco SQLite fica no volume Docker `sqlite-data`. O app tambem tem uma rota autenticada:

```text
/api/backup
```

Abra no navegador depois de fazer login para baixar um JSON com os dados principais.
