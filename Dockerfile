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

# Install Bebas Neue font (RSA headlines)
RUN mkdir -p /usr/local/share/fonts/bebas-neue \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
       -O /usr/local/share/fonts/bebas-neue/BebasNeue-Regular.ttf

# Install Montserrat font (RSA body)
RUN mkdir -p /usr/local/share/fonts/montserrat \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/montserrat/Montserrat-Variable.ttf

# Install Plus Jakarta Sans font (VoiceAI Connect)
RUN mkdir -p /usr/local/share/fonts/plus-jakarta-sans \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/plus-jakarta-sans/PlusJakartaSans-Variable.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/plusjakartasans/PlusJakartaSans-Italic%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/plus-jakarta-sans/PlusJakartaSans-Italic-Variable.ttf

# Install Space Mono font (VoiceAI Connect monospace accents)
RUN mkdir -p /usr/local/share/fonts/space-mono \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Regular.ttf" \
       -O /usr/local/share/fonts/space-mono/SpaceMono-Regular.ttf \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Bold.ttf" \
       -O /usr/local/share/fonts/space-mono/SpaceMono-Bold.ttf

# Refresh font cache
RUN fc-cache -fv

WORKDIR /workspace

# Copy package files and install
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY . .

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "src/server.js"]