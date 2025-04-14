defmodule ArbitrazeWeb.TradeLive.Index do
  @moduledoc false
  use ArbitrazeWeb, :live_view

  alias Arbitraze.Kalshi.KalshiWebSocketClient

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <.header>
        Ticker Stream
      </.header>

      <.table id="events" rows={@streams.events}>
        <:col :let={{_id, event}} label="Ticker">{event["msg"]["market_ticker"]}</:col>
        <:col :let={{_id, event}} label="Price">{event["msg"]["price"]}</:col>
        <:col :let={{_id, event}} label="Open Interest ($)">
          {event["msg"]["dollar_open_interest"]}
        </:col>
        <:col :let={{_id, event}} label="Yes Ask ($)">{event["msg"]["yes_ask"]}</:col>
        <:col :let={{_id, event}} label="Yes Bid ($)">{event["msg"]["yes_bid"]}</:col>
      </.table>
    </Layouts.app>
    """
  end

  @impl true
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(:page_title, "Trade")
      |> stream_configure(:events, dom_id: &"events-#{&1["type"]}-#{&1["msg"]["market_ticker"]}-#{&1["msg"]["ts"]}")
      |> stream(:events, [])

    if connected?(socket), do: KalshiWebSocketClient.pubsub_subscribe("kalshi_ticker")

    {:ok, socket}
  end

  @impl true
  def handle_info({:kalshi_event, event_data}, socket) do
    socket = stream_insert(socket, :events, event_data, at: 0)

    {:noreply, socket}
  end
end
