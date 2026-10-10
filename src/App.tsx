import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { NotFound } from './components/NotFound'
import { SceneLibrary } from './features/scenes/SceneLibrary'
import { SceneDetails } from './features/scenes/SceneDetails'
import { CreateRoomPage, RoomEntry } from './features/rooms/RoomEntry'
import { RoomPage } from './features/rooms/RoomPage'
import { SceneStudio } from './features/studio/SceneStudio'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<SceneLibrary />} />
        <Route path="scenes/:sceneId" element={<SceneDetails />} />
        <Route path="scenes/:sceneId/create" element={<CreateRoomPage />} />
        <Route path="studio" element={<SceneStudio />} />
        <Route path="studio/:sceneId" element={<SceneStudio />} />
        <Route path="join" element={<RoomEntry />} />
        <Route path="room/:code" element={<RoomPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
