FROM node:20-slim

# Install Chrome and font dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fontconfig \
    unzip \
    --no-install-recommends

# Install Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── RSA Fonts ─────────────────────────────────────────────────────

# Bebas Neue (RSA headlines)
RUN mkdir -p /usr/local/share/fonts/bebas-neue \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
       -O /usr/local/share/fonts/bebas-neue/BebasNeue-Regular.ttf

# Montserrat (RSA body)
RUN mkdir -p /usr/local/share/fonts/montserrat \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/montserrat/Montserrat-Variable.ttf

# ── VoiceAI Connect Fonts ────────────────────────────────────────

# Plus Jakarta Sans (VoiceAI Connect primary)
RUN mkdir -p /usr/local/share/fonts/plus-jakarta-sans \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/plus-jakarta-sans/PlusJakartaSans-Variable.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans-Italic%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/plus-jakarta-sans/PlusJakartaSans-Italic-Variable.ttf

# Space Mono (VoiceAI Connect monospace accents)
RUN mkdir -p /usr/local/share/fonts/space-mono \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Regular.ttf" \
       -O /usr/local/share/fonts/space-mono/SpaceMono-Regular.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Bold.ttf" \
       -O /usr/local/share/fonts/space-mono/SpaceMono-Bold.ttf

# ── CallBird AI Fonts ────────────────────────────────────────────

# Sora (CallBird headlines)
RUN mkdir -p /usr/local/share/fonts/sora \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/sora/Sora%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/sora/Sora-Variable.ttf

# Inter (CallBird body)
RUN mkdir -p /usr/local/share/fonts/inter \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" \
       -O /usr/local/share/fonts/inter/Inter-Variable.ttf

# ── GTC Group Fonts (using professional defaults until defined) ──

# Poppins (clean professional headlines)
RUN mkdir -p /usr/local/share/fonts/poppins \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf" \
       -O /usr/local/share/fonts/poppins/Poppins-Bold.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-SemiBold.ttf" \
       -O /usr/local/share/fonts/poppins/Poppins-SemiBold.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Regular.ttf" \
       -O /usr/local/share/fonts/poppins/Poppins-Regular.ttf

# Refresh font cache (must be LAST after all font installs)
RUN fc-cache -fv

WORKDIR /workspace

# Create renders directory for static file serving
RUN mkdir -p /workspace/renders

# Copy package files and install
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY . .

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "src/server.js"]