# Mental Avatar Installation Manual

This guide is for setting up Mental Avatar on a new Windows PC after cloning the repository.

The default path used by the current scripts is:

```bat
D:\MyWork\mental-avatar
```

Using the same path is recommended because some data, model, and helper-script paths are currently written around that workspace layout.

## 1. Prerequisites

Install these first:

- Git for Windows
- Miniconda or Anaconda, with `conda` available in a new terminal
- Python 3.11 through Conda
- Node.js 18 or newer, with `npm` added to `PATH`
- Ollama, if you want local LLM chat
- Optional: Google Chrome, if you use the Claude.ai session bridge
- Optional: NVIDIA GPU driver and CUDA-compatible PyTorch, if you use heavy avatar/video features

Check from PowerShell:

```powershell
git --version
conda --version
node --version
npm --version
ollama --version
```

## 2. Quick Install

Clone the project:

```powershell
git clone https://github.com/jinguheo/mental_avatar.git D:\MyWork\mental-avatar
cd D:\MyWork\mental-avatar
```

Run the setup helper:

```powershell
powershell -ExecutionPolicy Bypass -File migrate\setup_new_pc.ps1
```

The helper performs these steps:

- Creates the `avatar` Conda environment with Python 3.11
- Installs Python packages from `requirements.txt`
- Installs frontend Node packages in `frontend`
- Installs `my-dashboard` Node packages if `D:\MyWork\my-dashboard` exists
- Runs data restore through `migrate\restore_data.ps1`

Then start the main services manually:

```powershell
conda run -n avatar python api\server.py
cd frontend
npm run dev
```

Open [http://localhost:5174](http://localhost:5174).

## 3. Manual Install

Use this if you prefer to run each step yourself.

```powershell
git clone https://github.com/jinguheo/mental_avatar.git D:\MyWork\mental-avatar
cd D:\MyWork\mental-avatar

conda create -y -n avatar python=3.11
conda run -n avatar python -m pip install --upgrade pip
conda run -n avatar python -m pip install -r requirements.txt

cd frontend
npm install
npm run build
```

Start the API server:

```powershell
cd D:\MyWork\mental-avatar
conda run -n avatar python api\server.py
```

Start the frontend in a second terminal:

```powershell
cd D:\MyWork\mental-avatar\frontend
npm run dev
```

## 4. Optional GPU PyTorch

Install CUDA PyTorch before or after `requirements.txt` if you use GPU-heavy video, face swap, or SadTalker features.

```powershell
conda run -n avatar python -m pip install torch==2.5.1+cu121 torchvision==0.20.1+cu121 torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
```

If you do not use GPU features, you can skip this step.

## 5. Optional XTTS Voice Worker

XTTS is separated into its own Conda environment because it is heavy and can conflict with the main avatar environment.

```powershell
cd D:\MyWork\mental-avatar
conda create -y -n xtts python=3.11
conda run -n xtts python -m pip install --upgrade pip
conda run -n xtts python -m pip install torch==2.5.1+cu121 torchvision==0.20.1+cu121 torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
conda run -n xtts python -m pip install -r requirements-xtts.txt
```

Start the worker only when you need cloned/local voice synthesis:

```powershell
conda run -n xtts python api\xtts_server.py
```

## 6. Optional my-dashboard Integration

Mental Avatar can run by itself on port `5174`, but the full workflow often uses `my-dashboard` as the main dashboard.

Clone and install `my-dashboard` separately:

```powershell
git clone https://github.com/jinguheo/my_dashboard.git D:\MyWork\my-dashboard
cd D:\MyWork\my-dashboard
install.bat
```

When both projects exist in the default paths, `my-dashboard` can embed or start Mental Avatar through its helper scripts.

## 7. Services And Ports

| Service | Port | Required | Purpose |
| --- | ---: | --- | --- |
| Mental Avatar frontend | 5174 | Yes | React/Vite avatar UI |
| Avatar API server | 8766 | Yes | Search, memory, avatar, video, profile APIs |
| my-dashboard | 5173 | Optional | Main personal dashboard |
| my-dashboard MCP server | 8765 | Optional | Stocks, weather, RSS, file summary, Claude session bridge |
| XTTS worker | 8768 | Optional | Local/cloned voice synthesis |
| Ollama | 11434 | Optional | Local LLM backend |

## 8. Start Commands

Recommended minimal startup:

```powershell
cd D:\MyWork\mental-avatar
conda run -n avatar python api\server.py
```

In another terminal:

```powershell
cd D:\MyWork\mental-avatar\frontend
npm run dev
```

Optional watcher:

```powershell
cd D:\MyWork\mental-avatar
conda run -n avatar python watcher\file_watcher.py
```

Optional my-dashboard:

```powershell
cd D:\MyWork\my-dashboard
start_dashboard.bat
```

## 9. Models And External Assets

Large model files are not committed to Git. Text chat, search, profile, and knowledge graph features can work without these assets, but video/avatar generation features need extra files.

| Feature | Expected path | Notes |
| --- | --- | --- |
| SadTalker video generation | `D:\MyWork\SadTalker` | Clone and install SadTalker separately, including checkpoints |
| Face swap | `models\faceswap\inswapper_128.onnx` | Place the ONNX model manually |
| Rhubarb lip sync | `models\rhubarb\rhubarb.exe` | Download the Windows release and keep its `res` folder |
| XTTS model cache | `models\tts\...` or Hugging Face cache | First XTTS run may download large files |

## 10. Ollama Model

Install and start Ollama, then pull the default local model used by this project:

```powershell
ollama pull gemma4:e2b
```

You can use another model if the relevant config or UI setting is changed.

## 11. Data Restore

If you have a data bundle from another PC, copy it into:

```bat
D:\MyWork\mental-avatar\migrate
```

Then run:

```powershell
cd D:\MyWork\mental-avatar\migrate
powershell -ExecutionPolicy Bypass -File restore_data.ps1
```

Existing data is backed up before restore.

## 12. Verify Installation

Frontend:

```powershell
curl http://localhost:5174
```

Avatar API:

```powershell
curl http://127.0.0.1:8766
```

Production frontend build:

```powershell
cd D:\MyWork\mental-avatar\frontend
npm run build
```

Python import check:

```powershell
cd D:\MyWork\mental-avatar
conda run -n avatar python -m py_compile api\server.py watcher\file_watcher.py
```

## 13. Common Problems

`conda` is not found:

- Install Miniconda or Anaconda.
- Open a new PowerShell window after installation.
- Confirm `conda --version` works.

`npm` is not found:

- Install Node.js LTS.
- Open a new PowerShell window after installation.

Port already in use:

```powershell
netstat -ano | findstr ":5174"
netstat -ano | findstr ":8766"
```

Then stop the old process if it is an old dev server:

```powershell
taskkill /PID <PID> /F
```

Avatar API starts but frontend cannot connect:

- Confirm `api\server.py` is running on `http://127.0.0.1:8766`.
- Confirm `frontend\src\config.ts` uses `API_BASE = 'http://127.0.0.1:8766'`.

Ollama chat does not respond:

```powershell
ollama list
ollama pull gemma4:e2b
```

Video, face swap, or lip sync fails:

- Confirm the optional model files in section 9 exist.
- Confirm CUDA PyTorch is installed if you are using GPU mode.
- Start with basic chat/search features first, then enable heavy media features.

## 14. Update Existing Install

```powershell
cd D:\MyWork\mental-avatar
git pull
conda run -n avatar python -m pip install -r requirements.txt
cd frontend
npm install
npm run build
```

If you use XTTS:

```powershell
cd D:\MyWork\mental-avatar
conda run -n xtts python -m pip install -r requirements-xtts.txt
```

## 15. Installation Files

- `INSTALL.md`: this manual
- `requirements.txt`: main Python packages for the `avatar` Conda environment
- `requirements-xtts.txt`: optional XTTS voice-worker packages
- `migrate\setup_new_pc.ps1`: quick setup helper
- `migrate\restore_data.ps1`: data restore helper
- `frontend\package.json`: frontend Node dependencies and build scripts
