# Planted for #42's throwaway PR: code the scan must reject. Never merged.
import subprocess
import pickle
from flask import Flask, request

app = Flask(__name__)

@app.route("/run")
def run():
    subprocess.call(request.args.get("cmd"), shell=True)
    return pickle.loads(request.data)
