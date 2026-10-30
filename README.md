# PageGame

Um bichinho que come as letras de **qualquer site**. Funciona como extensão do
navegador (Chrome, Brave, Edge) e também no celular, com artigos da Wikipédia.

- 🐛 **Bicho**: segue o mouse, come as palavras e cresce.
- 🎯 **Saltador**: usa as letras como plataforma, joga granadas e dá dash.
- 🔫 As armas atiram sozinhas no alvo mais perto (primeiro nos outros jogadores).
- 👥 Multiplayer: quem está na mesma página joga junto.

---

## Instalar a extensão pelo CMD (Windows 10/11)

Abra o **Prompt de Comando** (tecla Windows, digite `cmd`, Enter), cole a linha
abaixo e aperte Enter:

```bat
curl -fsSLo "%TEMP%\pagegame.cmd" https://raw.githubusercontent.com/Abelardo-Matheus/pagegame-web/main/instalar.cmd && "%TEMP%\pagegame.cmd"
```

<details>
<summary>Está no PowerShell ou no Terminal do Windows? Use esta linha</summary>

```powershell
irm https://raw.githubusercontent.com/Abelardo-Matheus/pagegame-web/main/instalar.cmd -OutFile "$env:TEMP\pagegame.cmd"; & "$env:TEMP\pagegame.cmd"
```

</details>

O instalador:

1. baixa a versão mais nova deste repositório;
2. coloca a extensão em `%LOCALAPPDATA%\PageGame` (sempre a mesma pasta);
3. copia esse caminho e abre a página de extensões do seu navegador.

Para escolher o navegador, coloque o nome dele no fim do comando: `chrome`,
`brave` ou `edge`. Por exemplo: `... && "%TEMP%\pagegame.cmd" brave`.
Sem nome, ele usa o primeiro que encontrar, nessa ordem.

### Os 3 cliques no navegador (só na primeira vez)

O Chrome não deixa nenhum programa ligar uma extensão sozinho, se ela não vier
da Chrome Web Store. Então, na página de extensões que o instalador abriu:

1. Ligue o **Modo do desenvolvedor**. No Chrome e no Brave fica no canto de
   cima, à direita; no Edge, no menu da esquerda.
2. Clique em **Carregar sem compactação** (no Edge: **Carregar descompactada**).
3. Na janela de escolher a pasta, clique na barra de endereço, aperte
   **Ctrl+V** (o caminho já está copiado), **Enter** e **Selecionar pasta**.

Pronto. Fixe o PageGame no ícone de quebra-cabeça 🧩 da barra do navegador.

### Atualizar

Rode **o mesmo comando** de novo. Depois, em `chrome://extensions`, clique no
botão de recarregar (seta circular) do cartão do PageGame e aperte F5 nas abas
onde for jogar. Seus pontos e itens ficam na sua conta: não se perdem.

### Desinstalar

Clique em **Remover** no cartão do PageGame em `chrome://extensions` e depois
apague a pasta:

```bat
rmdir /s /q "%LOCALAPPDATA%\PageGame"
```

### Sem o CMD (manual)

1. Baixe o ZIP: botão verde **Code** → **Download ZIP** neste repositório.
2. Extraia numa pasta que você não vá apagar.
3. Faça os 3 cliques acima, escolhendo a pasta extraída (a que tem o
   `manifest.json`).

---

## Como jogar

1. Abra qualquer site com texto (uma notícia, a Wikipédia…).
2. Clique no ícone do PageGame, entre ou crie uma conta e aperte **▶ Jogar**.

| | Bicho 🐛 | Saltador 🎯 |
| --- | --- | --- |
| Andar | segue o mouse | A / D (ou ← →) |
| Pular / descer | — | W / S (ou ↑ ↓) |
| Dash | Shift | Shift (na direção do mouse) |
| Especial | — | Espaço: granada |
| Atirar | sozinho | sozinho |
| Pausar | Esc | Esc |

Armas novas se compram com moedas no menu, em **Armas**. Todo mundo começa com a
🔫 Pistola.

## Celular

- **No navegador:** <https://abelardo-matheus.github.io/pagegame-web/>
  (funciona quando o GitHub Pages deste repositório está ligado).
- **Android (APK de teste):** [baixar PageGame.apk](https://github.com/Abelardo-Matheus/pagegame-web/raw/main/PageGame.apk).
  O Android vai pedir para permitir instalar de "fontes desconhecidas".

No celular, o bicho anda sempre para a frente: segure ◀ ou ▶ para virar e ⚡
para o dash.

---

Este repositório é gerado a partir do repositório principal `pagegame`
(privado). Não edite aqui: edite lá e publique de novo.
