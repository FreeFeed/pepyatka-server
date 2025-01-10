FROM node:18-bookworm

RUN apt-get update && \
    apt-get install -y \
    imagemagick \
    ffmpeg \
    g++ \
    git \
    make

ADD . /server
WORKDIR /server

RUN rm -rf node_modules && \
    rm -f log/*.log && \
    mkdir -p ./public/files/attachments && \
    yarn install

ENV NODE_ENV production

CMD ["yarn","start"]
