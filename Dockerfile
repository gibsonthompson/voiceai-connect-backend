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

# Install Bebas Neue font
RUN mkdir -p /usr/local/share/fonts/bebas-neue \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
       -O /usr/local/share/fonts/bebas-neue/BebasNeue-Regular.ttf

# Install Montserrat font
RUN mkdir -p /usr/local/share/fonts/montserrat \
    && wget -q "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
       -O /usr/local/share/fonts/montserrat/Montserrat-Variable.ttf

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
