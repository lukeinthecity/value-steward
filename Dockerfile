# Use a combined Node and Python environment
FROM nikolaik/python-nodejs:python3.10-nodejs20

# Set professional working directory
WORKDIR /app

# Install system dependencies and cron
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    cron \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for efficient layer caching
COPY package*.json ./
COPY requirements.txt ./

# Install Node and Python dependencies
RUN npm install --omit=dev
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Install the valuesteward package in editable mode for the Python brain
RUN pip install -e .

# Setup Cron
COPY crontab /etc/cron.d/steward-cron
RUN chmod 0644 /etc/cron.d/steward-cron
RUN crontab /etc/cron.d/steward-cron

# Create persistent data directories and log files
RUN mkdir -p data logs config && touch logs/cron.log && chmod 666 logs/cron.log

# Set environment defaults
ENV PYTHONPATH=/app/src
ENV VS_EXECUTION_ARMED=false
ENV VS_SHADOW_MODE=true

# Start the cron service and tail the log
CMD ["sh", "-c", "printenv > /etc/environment && chmod 0600 /etc/environment && touch /app/logs/cron.log && cron && tail -f /app/logs/cron.log"]
