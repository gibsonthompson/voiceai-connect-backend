#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Content Render Service — Setup Script
# Run this ONCE on your DigitalOcean droplet
# ══════════════════════════════════════════════════════════════════

echo "=== Installing Google Chrome ==="
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable

echo "=== Installing font dependencies ==="
sudo apt-get install -y fonts-liberation fontconfig wget unzip

echo "=== Installing Bebas Neue ==="
sudo mkdir -p /usr/local/share/fonts/bebas-neue
cd /tmp
wget -q "https://fonts.google.com/download?family=Bebas+Neue" -O bebas-neue.zip 2>/dev/null || \
  wget -q "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" -O /usr/local/share/fonts/bebas-neue/BebasNeue-Regular.ttf
if [ -f bebas-neue.zip ]; then
  unzip -o bebas-neue.zip -d /usr/local/share/fonts/bebas-neue/ 2>/dev/null
  rm bebas-neue.zip
fi

echo "=== Installing Montserrat ==="
sudo mkdir -p /usr/local/share/fonts/montserrat
wget -q "https://fonts.google.com/download?family=Montserrat" -O montserrat.zip 2>/dev/null || \
  wget -q "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" -O /usr/local/share/fonts/montserrat/Montserrat.ttf
if [ -f montserrat.zip ]; then
  unzip -o montserrat.zip -d /usr/local/share/fonts/montserrat/ 2>/dev/null
  rm montserrat.zip
fi

echo "=== Installing Plus Jakarta Sans ==="
sudo mkdir -p /usr/local/share/fonts/plus-jakarta-sans
wget -q "https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf" -O /usr/local/share/fonts/plus-jakarta-sans/PlusJakartaSans.ttf 2>/dev/null
wget -q "https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans-Italic%5Bwght%5D.ttf" -O /usr/local/share/fonts/plus-jakarta-sans/PlusJakartaSans-Italic.ttf 2>/dev/null

echo "=== Installing Space Mono ==="
sudo mkdir -p /usr/local/share/fonts/space-mono
wget -q "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Regular.ttf" -O /usr/local/share/fonts/space-mono/SpaceMono-Regular.ttf 2>/dev/null
wget -q "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Bold.ttf" -O /usr/local/share/fonts/space-mono/SpaceMono-Bold.ttf 2>/dev/null

echo "=== Refreshing font cache ==="
sudo fc-cache -fv

echo "=== Verifying ==="
echo "Chrome: $(google-chrome-stable --version)"
echo "Fonts installed:"
fc-list | grep -i "bebas\|montserrat" | head -10

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Copy the content-render/ folder to your VoiceAI Connect server"
echo "2. cd content-render && npm install puppeteer-core cors express"
echo "3. In your main server file, add:"
echo "   const contentRender = require('./content-render');"
echo "   app.use('/api/content-render', contentRender);"
echo "4. Set env vars:"
echo "   RENDER_SERVICE_KEY=your-secret-key (optional, for auth)"
echo "   CHROME_PATH=/usr/bin/google-chrome-stable (if not default)"
echo "5. Restart your server"
echo "6. Test: curl http://localhost:YOUR_PORT/api/content-render/health"