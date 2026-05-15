#!/bin/bash
set -e

echo "Installing Auto-Deploy as a systemd service..."

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed. Installing..."

    # Determine the package manager
    if command -v apt &> /dev/null; then
        # Debian/Ubuntu
        sudo apt update
        sudo apt install -y nodejs npm
    elif command -v dnf &> /dev/null; then
        # Fedora
        sudo dnf install -y nodejs npm
    elif command -v yum &> /dev/null; then
        # CentOS/RHEL
        sudo yum install -y nodejs npm
    elif command -v pacman &> /dev/null; then
        # Arch Linux
        sudo pacman -Sy nodejs npm
    else
        echo "Could not determine package manager. Please install Node.js manually."
        exit 1
    fi

    echo "Node.js installed successfully."
else
    echo "Node.js is already installed: $(node -v)"
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Build the project
echo "Building the project..."
npm run build

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo ""
    echo "WARNING: No .env file found!"
    echo "Please create a .env file with the following variables:"
    echo "  PORT=3000"
    echo "  MASTER_KEY=your-secret-key-here (at least 16 characters)"
    echo "  NODE_ENV=production"
    echo ""
    read -p "Press Enter to continue or Ctrl+C to exit and create .env first..."
fi

# Get the current user
CURRENT_USER=$(whoami)

# Get the absolute path to the project directory
PROJECT_DIR="$SCRIPT_DIR"

# Get the path to node
NODE_PATH=$(which node)

# Create a temporary service file with the correct paths
SERVICE_FILE="/tmp/auto-deploy.service"
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Auto-Deploy - Webhook-driven deployment server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_PATH $PROJECT_DIR/dist/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=auto-deploy

# Load environment variables from .env file
EnvironmentFile=$PROJECT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Copy the service file to systemd directory
echo "Installing systemd service..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/auto-deploy.service
rm "$SERVICE_FILE"

# Reload systemd daemon
echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

# Enable the service to start on boot
echo "Enabling auto-deploy service..."
sudo systemctl enable auto-deploy

# Start the service
echo "Starting auto-deploy service..."
sudo systemctl start auto-deploy

# Check the status
echo ""
echo "Installation complete!"
echo ""
echo "Service status:"
sudo systemctl status auto-deploy --no-pager

echo ""
echo "Useful commands:"
echo "  sudo systemctl status auto-deploy    # Check service status"
echo "  sudo systemctl stop auto-deploy      # Stop the service"
echo "  sudo systemctl start auto-deploy     # Start the service"
echo "  sudo systemctl restart auto-deploy   # Restart the service"
echo "  sudo journalctl -u auto-deploy -f    # View live logs"
echo "  sudo systemctl disable auto-deploy   # Disable auto-start on boot"
echo ""
