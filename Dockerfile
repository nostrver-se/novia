FROM node:22

RUN apt-get update -y && apt-get install -y wget ffmpeg coreutils

RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY . /app/
RUN npm install
RUN npm run build

# example media folder /app/media
RUN mkdir media

# ENV DEBUG=novia*

ENTRYPOINT [ "node", "dist/index.js", "serve" ]
