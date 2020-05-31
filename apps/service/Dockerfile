FROM mhart/alpine-node

WORKDIR /var/app

EXPOSE 8080

COPY ./dist ./dist
COPY ./node_modules ./node_modules
COPY ./package.json ./package.json
COPY ./package-lock.json ./package-lock.json

CMD ["npm", "run", "start:prod"]