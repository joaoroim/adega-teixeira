# Comandas Adega

App web (PWA) para comandas e venda direta de adega. Sem cadastro de produtos: o produto e o valor são digitados na hora e o app lembra para sugerir depois. Fundo preto, mobile first, funciona offline.

- Banco SQLite rodando no navegador (sql.js), salvo no próprio aparelho (IndexedDB).
- Backup/restauração do arquivo `.sqlite` na aba **Produtos**.
- Sem login, sem servidor: basta hospedar estes arquivos estáticos em HTTPS (ex.: GitHub Pages).

## Rodar localmente

    python3 -m http.server 8000

Abra http://localhost:8000. Para instalar no celular, abra o endereço HTTPS no navegador e use "Adicionar à tela inicial".
